-- =============================================================================
-- Default "Main" branch on self_signup company creation
-- =============================================================================
-- Sin esto, una company self_signup arranca sin branches y el owner no
-- puede crear departments (FK departments.branch_id NOT NULL).
--
-- Extendemos handle_new_user → en el path self_signup, después de crear
-- la company + el owner employee, creamos también una branch "Main"
-- con el timezone detectado del browser (almacenado en metadata) o UTC.
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
  -- Timezone del browser viene en raw_user_meta_data; sino UTC.
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

GRANT INSERT ON public.branches TO postgres;

-- Backfill: companies self_signup que se crearon sin branch obtienen "Main".
INSERT INTO public.branches (company_id, name, timezone)
SELECT c.id, 'Main', 'UTC'
FROM public.companies c
LEFT JOIN public.branches b ON b.company_id = c.id
WHERE b.id IS NULL
  AND c.created_via IN ('self_signup', 'sql_seed');
