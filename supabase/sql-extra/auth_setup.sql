-- =============================================================================
-- auth.handle_new_user trigger — APLICACIÓN MANUAL como supabase_admin
-- =============================================================================
-- `supabase start` corre migrations como rol `postgres`, que NO tiene CREATE
-- en el schema `auth`. La función handle_new_user vivía en migrations/
-- (`20260513000000_invitation_flow.sql` + 3 redefiniciones) pero migrarla
-- requería supabase_admin → bloqueaba el restart.
--
-- Los helpers que solo leen claims del JWT (`user_company_id`, `user_role`,
-- etc.) se renombraron de `auth.*` → `public.*` y quedaron en migrations/
-- (postgres puede crearlos en public). El trigger handle_new_user NO se
-- puede mover porque Supabase Auth dispara INSERT en `auth.users` y solo
-- escucha triggers ahí mismo.
--
-- Aplicar (local dev, una vez por fresh `supabase start`):
--   docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
--     psql -U supabase_admin -d postgres < supabase/sql-extra/auth_setup.sql
--
-- Aplicar (Supabase Cloud / self-hosted prod):
--   Dashboard → SQL Editor → pegar contenido → Run como project owner.
-- =============================================================================

-- ─── handle_new_user — versión consolidada ──────────────────────────────────
-- Última definición unificada de las 4 migrations originales (invitation_flow,
-- self_signup, self_signup_oauth, default_branch_on_signup). Maneja:
--   Path 1: invitación pending → crea employee linked en company existente.
--   Path 2: self-signup → crea company + branch "Main" + employee owner +
--           onboarding_draft.

CREATE OR REPLACE FUNCTION auth.handle_new_user()
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

  -- Path 1: invitación pending → employee en company existente.
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

  IF inv.id IS NOT NULL THEN
    INSERT INTO public.employees (
      company_id, name, phone_number, hire_date, role, department_id, auth_user_id
    ) VALUES (
      inv.company_id, display_name, NEW.phone, CURRENT_DATE,
      inv.role, inv.department_id, NEW.id
    );

    UPDATE public.auth_invitations
      SET consumed_at = now()
      WHERE id = inv.id;

    RETURN NEW;
  END IF;

  -- Path 2: self-signup → crea company + branch default + employee owner + draft.
  default_tz := COALESCE(NEW.raw_user_meta_data ->> 'timezone', 'UTC');

  INSERT INTO public.companies (name, created_via, trial_ends_at)
    VALUES (NULL, 'self_signup', now() + interval '14 days')
    RETURNING id INTO new_company_id;

  -- Default branch "Main". El owner la renombra después si quiere.
  INSERT INTO public.branches (company_id, name, timezone)
    VALUES (new_company_id, 'Main', default_tz);

  INSERT INTO public.employees (
    company_id, name, phone_number, hire_date, role, auth_user_id
  ) VALUES (
    new_company_id, display_name, NEW.phone, CURRENT_DATE, 'owner', NEW.id
  );

  INSERT INTO public.onboarding_drafts (company_id, current_step, data)
    VALUES (new_company_id, 1, '{}'::jsonb)
    ON CONFLICT (company_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ─── Trigger on auth.users ───────────────────────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.handle_new_user();
