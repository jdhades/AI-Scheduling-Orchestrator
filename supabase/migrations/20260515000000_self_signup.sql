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
    company_id = public.user_company_id()
    AND public.user_role() = 'owner'
  )
  WITH CHECK (
    company_id = public.user_company_id()
    AND public.user_role() = 'owner'
  );

-- ─── 3. handle_new_user → ver sql-extra/auth_setup.sql ─────────────────────
-- La versión consolidada (que ramifica entre self-signup, invitation, OAuth,
-- y default branch) vive en `supabase/sql-extra/auth_setup.sql`. Es la
-- definición final post-redefiniciones; esta migration ya no la toca porque
-- CREATE FUNCTION en `auth` requiere supabase_admin (postgres no tiene
-- CREATE ahí). Apply: ver header de auth_setup.sql.

GRANT INSERT ON public.companies TO postgres;
GRANT INSERT ON public.onboarding_drafts TO postgres;
