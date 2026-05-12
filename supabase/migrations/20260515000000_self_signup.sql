-- =============================================================================
-- Self-signup flow (PR Self-Signup del sprint Marketing/Onboarding)
-- =============================================================================
-- Habilita "Start free trial" desde la landing pública. Cualquier visitante
-- puede crear una company + ser owner sin invitación previa. El trigger
-- handle_new_user diferencia los dos paths según `raw_user_meta_data.signup_intent`.
--
--   signup_intent='self_signup'  →  crea company + employee owner
--   sin signup_intent            →  flujo invitation (legacy, sin cambios)
--
-- TODO(billing): trial_ends_at se setea pero NO se enforza bloqueo. Antes
-- de ir a producción hay que:
--   - Agregar middleware que rechace requests si companies.trial_ends_at
--     < now() AND companies.subscription_status IS NULL.
--   - Definir columna companies.subscription_status (enum: trialing |
--     active | past_due | canceled) + integración con proveedor de pago.
--   - Banner en dashboard "Trial ends in N days" + flujo de checkout.
-- =============================================================================

-- ─── 1. Columnas nuevas en companies ───────────────────────────────────────
ALTER TABLE public.companies
  ALTER COLUMN name DROP NOT NULL;

-- companies.name puede ser null al momento de self-signup (la pedimos en
-- el wizard step 2). Para los seeds existentes ya tiene valor; no
-- backfill necesario.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'sql_seed'
    CHECK (created_via IN ('sql_seed', 'self_signup', 'sales_demo')),
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

-- ─── 2. Tabla onboarding_drafts ────────────────────────────────────────────
-- Persiste el state del wizard entre pasos para que el user pueda dejar
-- el browser abierto/cerrar la pestaña y retomar. Una fila por company.
-- Se borra cuando POST /onboarding/complete marca companies.onboarded_at.

CREATE TABLE IF NOT EXISTS public.onboarding_drafts (
  company_id   UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  current_step SMALLINT NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 6),
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_drafts_updated_idx
  ON public.onboarding_drafts(updated_at DESC);

-- RLS: tenant_isolation pattern, dentro de la company. Solo owner accede.
ALTER TABLE public.onboarding_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_drafts_owner_all ON public.onboarding_drafts;
CREATE POLICY onboarding_drafts_owner_all ON public.onboarding_drafts
  FOR ALL TO authenticated
  USING (
    company_id = auth.user_company_id()
    AND auth.user_role() = 'owner'
  )
  WITH CHECK (
    company_id = auth.user_company_id()
    AND auth.user_role() = 'owner'
  );

-- ─── 3. Extender handle_new_user para self-signup ──────────────────────────
-- Mismo trigger que el flow de invitations (PR 7), pero ahora ramifica:
-- si raw_user_meta_data.signup_intent = 'self_signup' → crea company +
-- employee owner. Cualquier otro caso cae al flow original (invitation
-- obligatoria). Mantiene SECURITY DEFINER + search_path=''.

CREATE OR REPLACE FUNCTION auth.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inv             RECORD;
  display_name    TEXT;
  workspace_name  TEXT;
  new_company_id  UUID;
  signup_intent   TEXT;
BEGIN
  signup_intent := NEW.raw_user_meta_data ->> 'signup_intent';

  display_name := COALESCE(
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'full_name',
    split_part(COALESCE(NEW.email, NEW.phone), '@', 1)
  );

  -- Self-signup branch: crear company + employee owner atómico.
  IF signup_intent = 'self_signup' THEN
    workspace_name := NULL; -- el wizard step 2 lo completa
    INSERT INTO public.companies (name, created_via, trial_ends_at)
      VALUES (workspace_name, 'self_signup', now() + interval '14 days')
      RETURNING id INTO new_company_id;

    INSERT INTO public.employees (
      company_id, name, phone_number, hire_date, role, auth_user_id
    ) VALUES (
      new_company_id, display_name, NEW.phone, CURRENT_DATE, 'owner', NEW.id
    );

    -- Crear draft inicial vacío para que el wizard arranque limpio.
    INSERT INTO public.onboarding_drafts (company_id, current_step, data)
      VALUES (new_company_id, 1, '{}'::jsonb)
      ON CONFLICT (company_id) DO NOTHING;

    RETURN NEW;
  END IF;

  -- Invitation flow (legacy, sin cambios).
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
            HINT   = 'A manager must invite this user via /auth/invitations before signup, or signup self-service via the landing page.';
  END IF;

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
END;
$$;

-- Trigger ya existe (PR 7); el CREATE OR REPLACE arriba actualiza la
-- función sin tocar el trigger. Grants también ya están vigentes.
-- Agregamos solo los grants nuevos para companies y onboarding_drafts.
GRANT INSERT ON public.companies TO postgres;
GRANT INSERT ON public.onboarding_drafts TO postgres;
