-- =============================================================================
-- email en employees + employee_id en auth_invitations
-- =============================================================================
-- Sprint invite-flow real (2026-05-26).
--
-- Cambios:
--   1) employees.email TEXT nullable — manager carga el email al crear/editar
--      el row HR; sirve después para mandar invitación a esa persona específica.
--   2) auth_invitations.employee_id UUID FK → employees(id) nullable — cuando
--      se invita a un employee ya existente, vincula la invitación al row HR.
--      Cuando se invita a alguien que NO está en employees todavía (path "team")
--      queda NULL y el trigger crea row nuevo (path actual).
--   3) handle_new_user actualizado: si invitation.employee_id IS NOT NULL,
--      hace UPDATE del row existente con auth_user_id (linkea) en vez de
--      INSERT nuevo. Evita duplicados employee↔auth_user.
--
-- Nota: la función handle_new_user en Supabase Cloud está en public schema
-- (ver sql-extra/auth_setup_cloud.sql). Acá redefinimos esa versión.

-- ─── 1. email en employees ─────────────────────────────────────────────────
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Email único por company (no global) — dos companies pueden tener un
-- employee con el mismo email (manager en una, employee en otra).
-- Partial index para tolerar nulls múltiples.
CREATE UNIQUE INDEX IF NOT EXISTS employees_company_email_uniq
  ON public.employees (company_id, lower(email))
  WHERE email IS NOT NULL;

COMMENT ON COLUMN public.employees.email IS
  'Email del employee. Usado para mandar invitación de login (POST /auth/invitations con employee_id). Unique within company.';

-- ─── 2. employee_id en auth_invitations ────────────────────────────────────
ALTER TABLE public.auth_invitations
  ADD COLUMN IF NOT EXISTS employee_id UUID
    REFERENCES public.employees(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS auth_invitations_employee_id_idx
  ON public.auth_invitations(employee_id)
  WHERE employee_id IS NOT NULL;

COMMENT ON COLUMN public.auth_invitations.employee_id IS
  'Si set, el trigger handle_new_user linkea el employee existente en lugar de crear uno nuevo. NULL para invitaciones "ad-hoc" (employee se crea al aceptar).';

-- ─── 3. handle_new_user — versión Path 1a (linkea existente) ──────────────
-- Función en public (no auth) por la restricción de Supabase Cloud:
-- ver sql-extra/auth_setup_cloud.sql.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inv             RECORD;
  display_name    TEXT;
  new_company_id  UUID;
  default_tz      TEXT;
BEGIN
  display_name := COALESCE(
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'full_name',
    split_part(COALESCE(NEW.email, NEW.phone), '@', 1)
  );

  -- Path 1: invitación pending por email/phone.
  SELECT *
    INTO inv
  FROM public.auth_invitations
  WHERE consumed_at IS NULL
    AND expires_at > now()
    AND (
      (email IS NOT NULL AND lower(email) = lower(NEW.email))
      OR (phone_number IS NOT NULL AND phone_number = NEW.phone)
    )
  ORDER BY created_at DESC
  LIMIT 1;

  IF inv.id IS NOT NULL THEN
    IF inv.employee_id IS NOT NULL THEN
      -- Path 1a: invitación apunta a un employee existente → linkear.
      -- No tocamos role/dept/etc — el manager los definió al crear el row.
      -- Sí actualizamos email (puede estar null si el row se creó antes
      -- del sprint y la invitación trae el email canonical).
      UPDATE public.employees
        SET auth_user_id = NEW.id,
            email = COALESCE(email, inv.email),
            name = COALESCE(NULLIF(name, ''), display_name)
        WHERE id = inv.employee_id;
    ELSE
      -- Path 1b: invitación "ad-hoc" → crear employee nuevo en la company.
      INSERT INTO public.employees (
        company_id, name, email, phone_number, hire_date, role, department_id, auth_user_id
      ) VALUES (
        inv.company_id, display_name, inv.email, NEW.phone, CURRENT_DATE,
        inv.role, inv.department_id, NEW.id
      );
    END IF;

    UPDATE public.auth_invitations
      SET consumed_at = now()
      WHERE id = inv.id;

    RETURN NEW;
  END IF;

  -- Path 2: self-signup (no invitation) → crear company + branch + owner + draft.
  default_tz := COALESCE(NEW.raw_user_meta_data ->> 'timezone', 'UTC');

  INSERT INTO public.companies (name, created_via, trial_ends_at)
    VALUES (NULL, 'self_signup', now() + interval '14 days')
    RETURNING id INTO new_company_id;

  INSERT INTO public.branches (company_id, name, timezone)
    VALUES (new_company_id, 'Main', default_tz);

  INSERT INTO public.employees (
    company_id, name, email, phone_number, hire_date, role, auth_user_id
  ) VALUES (
    new_company_id, display_name, NEW.email, NEW.phone, CURRENT_DATE, 'owner', NEW.id
  );

  INSERT INTO public.onboarding_drafts (company_id, current_step, data)
    VALUES (new_company_id, 1, '{}'::jsonb)
    ON CONFLICT (company_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Trigger ya existe (creado por auth_setup_cloud.sql); CREATE OR REPLACE
-- de arriba alcanza para actualizar la lógica.
