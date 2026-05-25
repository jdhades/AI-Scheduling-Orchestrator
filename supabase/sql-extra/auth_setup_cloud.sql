-- =============================================================================
-- auth setup — versión Supabase Cloud (función en public, no en auth)
-- =============================================================================
-- Supabase Cloud no permite CREATE FUNCTION en schema `auth` (ni siquiera el
-- project owner). La fix: definir la función en `public` y el trigger sobre
-- `auth.users` (eso sí lo permite Cloud).
--
-- Aplicar:
--   Dashboard → SQL Editor → pegar este archivo entero → Run.
--
-- Para local (donde sí tenemos supabase_admin), seguir usando
-- `auth_setup.sql` con la función en auth.
-- =============================================================================

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

-- Permitir que Supabase Auth ejecute el SECURITY DEFINER. Sin esto, el
-- trigger se dispara pero falla al accionar la función con el rol authenticator.
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;

-- Trigger sobre auth.users — Supabase Cloud lo permite mientras la función
-- esté en public (o cualquier schema donde el owner tenga CREATE).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
