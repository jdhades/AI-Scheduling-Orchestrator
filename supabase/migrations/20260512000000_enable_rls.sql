-- =============================================================================
-- Row-Level Security (PR 6 del sprint Auth)
-- =============================================================================
-- Defensa en profundidad: aunque el backend filtre por companyId via
-- @CurrentCompany() (PR 5), si un bug deja entrar un companyId ajeno, RLS
-- lo bloquea a nivel motor SQL. Cuando el frontend haga llamadas directas
-- a Supabase (PR 11+), RLS es la ÚNICA garantía de isolation.
--
-- IMPORTANTE — service_role bypass:
-- El backend conecta con SERVICE_ROLE_KEY que ignora RLS por design.
-- Los queries del backend siguen funcionando idéntico. RLS solo aplica
-- a queries con anon_key + JWT user (típicamente frontend directo).
--
-- IMPORTANTE — Permisos: esta migration requiere rol `supabase_admin`
-- (postgres no puede crear functions en schema auth):
--   docker exec -i -e PGPASSWORD=postgres supabase_db_xxx \
--     psql -U supabase_admin -d postgres < <archivo>.sql
-- =============================================================================

-- ─── Helper functions en schema auth ────────────────────────────────────────
-- Leen custom claims del JWT actual. Si el access token hook NO está
-- activo (PR 4 lo dejó listo pero la registración es manual), estos
-- retornan NULL → policies que comparan `company_id = auth.user_company_id()`
-- dan 0 rows (NULL = X siempre es NULL → false en políticas). Fail-safe.

CREATE OR REPLACE FUNCTION auth.user_company_id()
RETURNS UUID
LANGUAGE SQL STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'company_id',
    ''
  )::UUID;
$$;

CREATE OR REPLACE FUNCTION auth.user_role()
RETURNS TEXT
LANGUAGE SQL STABLE
AS $$
  SELECT current_setting('request.jwt.claims', true)::jsonb ->> 'employee_role';
$$;

CREATE OR REPLACE FUNCTION auth.user_employee_id()
RETURNS UUID
LANGUAGE SQL STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'employee_id',
    ''
  )::UUID;
$$;

-- Permisos: rol `authenticated` (Supabase default para JWT user) debe
-- poder llamar los helpers desde dentro de policies. STABLE para que el
-- planner las cachee dentro del query.
GRANT EXECUTE ON FUNCTION auth.user_company_id() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.user_role() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.user_employee_id() TO authenticated, anon, service_role;

-- ─── Enable RLS + tenant_isolation policy genérica ──────────────────────────
-- Pattern por tabla: ENABLE ROW LEVEL SECURITY + policy `tenant_isolation`
-- con USING/WITH CHECK = `company_id = auth.user_company_id()`. Lo aplicamos
-- via DO block para no repetir el mismo DDL 17 veces.

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'employees',
    'shift_templates',
    'shift_memberships',
    'absence_reports',
    'shift_swap_requests',
    'day_off_requests',
    'fairness_history',
    'company_policies',
    'semantic_rules',
    'company_skills',
    'departments',
    'branches',
    'schedule_generation_runs',
    'llm_usage_log',
    'llm_model_budgets',
    'shift_assignment_edits',
    'auth_invitations'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    -- Drop si existe para que la migration sea idempotente.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         FOR ALL TO authenticated
         USING (company_id = auth.user_company_id())
         WITH CHECK (company_id = auth.user_company_id())',
      tbl
    );
  END LOOP;
END $$;

-- ─── llm_model_budgets — caso especial: NULL company_id = default global ────
-- La policy genérica niega NULL company_id (NULL = X → NULL → false).
-- Defaults globales deben ser visibles para todos los authenticated.
DROP POLICY IF EXISTS llm_model_budgets_global_readable ON public.llm_model_budgets;
CREATE POLICY llm_model_budgets_global_readable ON public.llm_model_budgets
  FOR SELECT TO authenticated
  USING (company_id IS NULL);

-- ─── shift_assignments — employee solo ve los SUYOS, manager ve todos ──────
ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.shift_assignments;
DROP POLICY IF EXISTS shift_assignments_employee_self_read ON public.shift_assignments;
DROP POLICY IF EXISTS shift_assignments_manager_all ON public.shift_assignments;

-- Employee: solo SUS shifts del tenant. Lookup employee_id desde
-- auth_user_id si no vino en el JWT directo (path B del guard).
CREATE POLICY shift_assignments_employee_self_read ON public.shift_assignments
  FOR SELECT TO authenticated
  USING (
    company_id = auth.user_company_id()
    AND (
      auth.user_role() = 'manager'
      OR employee_id = COALESCE(
        auth.user_employee_id(),
        (SELECT id FROM public.employees WHERE auth_user_id = auth.uid() LIMIT 1)
      )
    )
  );

-- Manager: full access dentro de su company.
CREATE POLICY shift_assignments_manager_all ON public.shift_assignments
  FOR ALL TO authenticated
  USING (
    company_id = auth.user_company_id()
    AND auth.user_role() = 'manager'
  )
  WITH CHECK (
    company_id = auth.user_company_id()
    AND auth.user_role() = 'manager'
  );

-- ─── auth_audit_log — solo manager LEE, nadie INSERTA via API ──────────────
-- INSERTs los hace el backend con service_role (bypass RLS).
ALTER TABLE public.auth_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_audit_log_manager_read ON public.auth_audit_log;
CREATE POLICY auth_audit_log_manager_read ON public.auth_audit_log
  FOR SELECT TO authenticated
  USING (
    company_id = auth.user_company_id()
    AND auth.user_role() = 'manager'
  );
