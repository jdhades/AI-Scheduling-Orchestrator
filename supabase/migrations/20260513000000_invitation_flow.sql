-- =============================================================================
-- Invitation flow (PR 7 del sprint Auth)
-- =============================================================================
-- Trigger en auth.users INSERT que consume invitaciones pending y crea
-- la fila `employees` linkeada. El manager dispara POST /auth/invitations
-- (genera token + email), el usuario abre el link, Supabase crea el
-- auth.users row, este trigger corre y completa el setup.
--
-- IMPORTANTE — Permisos: requiere rol `supabase_admin` para crear el
-- trigger en auth.users.
-- =============================================================================

-- ─── 1. employees.phone_number → nullable ───────────────────────────────────
-- Schema legacy requería phone_number NOT NULL (path WhatsApp). Con el
-- nuevo flow de invitación email-only para managers, no siempre hay
-- phone — el manager corporativo no usa WhatsApp. Default a string vacío
-- mantiene compat con queries que asumen no-null.

ALTER TABLE public.employees
  ALTER COLUMN phone_number DROP NOT NULL;

-- Nullable invited_by para tolerar el DEV bypass (user sin employee
-- linkeado). En prod con auth real, siempre tendrá valor — la
-- aplicación lo enforza via @CurrentUser.employeeId.
ALTER TABLE public.auth_invitations
  ALTER COLUMN invited_by DROP NOT NULL;

-- ─── 2. Trigger handle_new_user ─────────────────────────────────────────────
-- SECURITY DEFINER: corre como `postgres`/owner, bypasseando RLS (necesario
-- porque al INSERT en employees el role del caller es `supabase_auth_admin`
-- que no tiene policy permitiva). search_path='' restringe inyecciones.
--
-- Flow:
--   1) Lookup invitation pending por email o phone (no consumed, not expired).
--   2) Si no hay invitación → RAISE EXCEPTION (signup sin invitación = bloqueado).
--   3) INSERT employees con el role + departamento de la invitación.
--   4) UPDATE invitation.consumed_at = now().

CREATE OR REPLACE FUNCTION auth.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inv RECORD;
  display_name TEXT;
BEGIN
  -- Lookup invitación pending. Email tiene prioridad sobre phone
  -- (un mismo phone podría usarse por múltiples tenants en teoría).
  SELECT *
    INTO inv
  FROM public.auth_invitations
  WHERE consumed_at IS NULL
    AND expires_at > now()
    AND (
      (email IS NOT NULL AND email = NEW.email)
      OR (phone_number IS NOT NULL AND phone_number = NEW.phone)
    )
  ORDER BY created_at DESC
  LIMIT 1;

  IF inv.id IS NULL THEN
    RAISE EXCEPTION 'No pending invitation found for this user'
      USING ERRCODE = 'unique_violation',
            HINT   = 'A manager must invite this user via /auth/invitations before signup.';
  END IF;

  -- Nombre del user. Preferir raw_user_meta_data.name si lo manda el
  -- frontend (signup form con full_name); sino, derivar del email.
  display_name := COALESCE(
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'full_name',
    split_part(COALESCE(NEW.email, NEW.phone), '@', 1)
  );

  INSERT INTO public.employees (
    company_id,
    name,
    phone_number,
    hire_date,
    role,
    department_id,
    auth_user_id
  ) VALUES (
    inv.company_id,
    display_name,
    NEW.phone,
    CURRENT_DATE,
    inv.role,
    inv.department_id,
    NEW.id
  );

  UPDATE public.auth_invitations
    SET consumed_at = now()
    WHERE id = inv.id;

  RETURN NEW;
END;
$$;

-- Idempotente: drop si existe (re-aplicar la migration no falla).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.handle_new_user();

-- Grants para que el rol que ejecuta el trigger pueda leer/escribir.
-- SECURITY DEFINER ya hace que corra como el owner, pero el SET search_path=''
-- requiere referencias explícitas a public.*.
GRANT SELECT, UPDATE ON public.auth_invitations TO postgres;
GRANT INSERT ON public.employees TO postgres;
