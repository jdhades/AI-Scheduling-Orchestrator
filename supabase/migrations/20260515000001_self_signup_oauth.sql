-- =============================================================================
-- Self-signup via OAuth — trigger handle_new_user defaults a self-signup
-- =============================================================================
-- La migration anterior (20260515000000) ramificaba por
-- `raw_user_meta_data.signup_intent`. Eso funciona para email/password
-- desde /auth/signup pero NO para OAuth (Google/Microsoft) — Supabase
-- llena raw_user_meta_data desde el profile del provider, no acepta
-- nuestros metadata custom en signInWithOAuth.
--
-- Reordenamos el trigger:
--   1) Si hay invitación pending para email/phone → invitation flow
--   2) Sino → self-signup flow (crea company + owner)
--
-- Esto naturalmente cubre los tres paths:
--   - email/password vía /auth/signup
--   - OAuth (Google/Microsoft)
--   - cualquier otro signup vía Supabase Auth nativo
--
-- Si alguien necesita el rechazo "signup sin invitación", se enforza a
-- nivel producto (cerrar Supabase signUp endpoint, dejar solo OAuth con
-- restricciones, etc.). El trigger ya no es el guard.
-- =============================================================================

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

  -- Path 2: self-signup → crea company + employee owner + draft inicial.
  -- Cubre email/password (signup_intent presente o no) y OAuth signups.
  INSERT INTO public.companies (name, created_via, trial_ends_at)
    VALUES (NULL, 'self_signup', now() + interval '14 days')
    RETURNING id INTO new_company_id;

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
