-- =============================================================================
-- RBAC Foundation — Sprint 1
-- =============================================================================
-- Modelo de permisos production-grade. Reemplaza el sistema actual de
-- `@Roles('manager')` checks atómicos por capabilities + scope.
--
-- Architecture:
--   1. company_role_capabilities — qué puede cada rol en cada company
--      (defaults sembrados al crear company; el owner los toggle en
--      Settings).
--   2. employee_capabilities — overrides por usuario individual. Usado
--      para "el owner le da permisos como owner a un manager específico":
--      el manager sigue siendo manager (role), pero adquiere capabilities
--      que normalmente solo tendría el owner.
--   3. manager_scopes — a qué branches/departments tiene acceso cada
--      manager. M:N. Asignar a una branch = acceso a todos sus depts.
--      Sin asignaciones = scope vacío (manager no ve nada scoped).
--   4. Helpers: public.user_has_capability(cap), public.user_dept_in_scope(id).
--
-- Effective permission(user, capability, resource):
--   has_cap = company_role_capabilities[user.role] OR employee_capabilities[user]
--   in_scope = user.role='owner' OR resource es no-scoped (billing, policies,
--              audit, settings) OR resource.dept_id ∈ manager_scopes[user]
--   permitted = has_cap AND in_scope
--
-- Catalog of capabilities vive como constants en TypeScript
-- (`src/domain/capabilities/catalog.ts`). Esta tabla solo guarda nombres
-- libres — agregar una capability nueva = code change + seed.
-- =============================================================================

-- ─── 1. company_role_capabilities ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_role_capabilities (
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','manager','employee')),
  capability  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, role, capability)
);

CREATE INDEX IF NOT EXISTS company_role_capabilities_company_idx
  ON public.company_role_capabilities(company_id);

-- ─── 2. employee_capabilities (per-user overrides) ─────────────────────
-- "el owner le da permisos como owner a un manager" se modela acá: un
-- INSERT por cada capability extra que el owner concede al manager.
-- El audit_log debería capturar estos grants — el campo `granted_by`
-- lo facilita.
CREATE TABLE IF NOT EXISTS public.employee_capabilities (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id  UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  capability   TEXT NOT NULL,
  granted_by   UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, capability)
);

CREATE INDEX IF NOT EXISTS employee_capabilities_employee_idx
  ON public.employee_capabilities(employee_id);

-- ─── 3. manager_scopes (M:N) ───────────────────────────────────────────
-- scope_id es polymorphic (apunta a branches.id o departments.id según
-- scope_type). No usamos FK polimórfica formal — la integridad la
-- mantiene la app + cleanup ON DELETE de las tablas referenciadas
-- (ver triggers más abajo).
CREATE TABLE IF NOT EXISTS public.manager_scopes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id  UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('branch','department')),
  scope_id     UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS manager_scopes_employee_idx
  ON public.manager_scopes(employee_id);
CREATE INDEX IF NOT EXISTS manager_scopes_scope_idx
  ON public.manager_scopes(scope_type, scope_id);

-- Cleanup: cuando se borra una branch/depto, eliminar las asignaciones
-- de scope correspondientes. Lo hacemos por trigger porque la FK no es
-- formal (polimórfica).
CREATE OR REPLACE FUNCTION public.cleanup_manager_scopes_on_branch_delete()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN
  DELETE FROM public.manager_scopes
  WHERE scope_type = 'branch' AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS cleanup_scopes_on_branch_delete ON public.branches;
CREATE TRIGGER cleanup_scopes_on_branch_delete
  BEFORE DELETE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_manager_scopes_on_branch_delete();

CREATE OR REPLACE FUNCTION public.cleanup_manager_scopes_on_dept_delete()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN
  DELETE FROM public.manager_scopes
  WHERE scope_type = 'department' AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS cleanup_scopes_on_dept_delete ON public.departments;
CREATE TRIGGER cleanup_scopes_on_dept_delete
  BEFORE DELETE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_manager_scopes_on_dept_delete();

-- ─── 4. RLS — tenant_isolation por employee_id → company_id ────────────
-- Las 3 tablas son tenant-scoped via el employee/company FK.
ALTER TABLE public.company_role_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_capabilities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_scopes           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.company_role_capabilities;
CREATE POLICY tenant_isolation ON public.company_role_capabilities
  FOR ALL TO authenticated
  USING (company_id = public.user_company_id())
  WITH CHECK (company_id = public.user_company_id());

DROP POLICY IF EXISTS tenant_isolation ON public.employee_capabilities;
CREATE POLICY tenant_isolation ON public.employee_capabilities
  FOR ALL TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE company_id = public.user_company_id())
  )
  WITH CHECK (
    employee_id IN (SELECT id FROM public.employees WHERE company_id = public.user_company_id())
  );

DROP POLICY IF EXISTS tenant_isolation ON public.manager_scopes;
CREATE POLICY tenant_isolation ON public.manager_scopes
  FOR ALL TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE company_id = public.user_company_id())
  )
  WITH CHECK (
    employee_id IN (SELECT id FROM public.employees WHERE company_id = public.user_company_id())
  );

-- ─── 5. Auth helpers ───────────────────────────────────────────────────
-- has_capability(cap) — checkea role-level OR override individual.
CREATE OR REPLACE FUNCTION public.user_has_capability(cap TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_role_capabilities crc
    WHERE crc.company_id = public.user_company_id()
      AND crc.role = public.user_role()
      AND crc.capability = cap
  ) OR EXISTS (
    SELECT 1 FROM public.employee_capabilities ec
    WHERE ec.employee_id = public.user_employee_id()
      AND ec.capability = cap
  );
$$;
GRANT EXECUTE ON FUNCTION public.user_has_capability(TEXT)
  TO authenticated, anon, service_role;

-- user_dept_in_scope(dept_id) — el dept está en el scope del user actual.
-- Owner = full scope. Manager = unión de sus manager_scopes (branch
-- implica todos sus depts).
CREATE OR REPLACE FUNCTION public.user_dept_in_scope(dept_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE
AS $$
  SELECT
    public.user_role() = 'owner'
    OR EXISTS (
      SELECT 1 FROM public.manager_scopes ms
      WHERE ms.employee_id = public.user_employee_id()
        AND (
          (ms.scope_type = 'department' AND ms.scope_id = dept_id)
          OR (
            ms.scope_type = 'branch'
            AND ms.scope_id = (SELECT branch_id FROM public.departments WHERE id = dept_id)
          )
        )
    );
$$;
GRANT EXECUTE ON FUNCTION public.user_dept_in_scope(UUID)
  TO authenticated, anon, service_role;

-- user_visible_dept_ids() — devuelve set de dept_ids visibles al user.
-- Útil para filtrar listings en queries directas.
CREATE OR REPLACE FUNCTION public.user_visible_dept_ids()
RETURNS SETOF UUID LANGUAGE SQL STABLE
AS $$
  SELECT d.id FROM public.departments d
  WHERE d.company_id = public.user_company_id()
    AND (
      public.user_role() = 'owner'
      OR d.id IN (
        SELECT scope_id FROM public.manager_scopes
        WHERE employee_id = public.user_employee_id() AND scope_type = 'department'
      )
      OR d.branch_id IN (
        SELECT scope_id FROM public.manager_scopes
        WHERE employee_id = public.user_employee_id() AND scope_type = 'branch'
      )
    );
$$;
GRANT EXECUTE ON FUNCTION public.user_visible_dept_ids()
  TO authenticated, anon, service_role;

-- ─── 6. Seed defaults para companies existentes ────────────────────────
-- Cualquier company que YA EXISTE recibe el set default de capabilities
-- por rol. Idempotente vía ON CONFLICT.
INSERT INTO public.company_role_capabilities (company_id, role, capability)
SELECT c.id, defaults.role, defaults.capability
FROM public.companies c
CROSS JOIN (VALUES
  -- Owner: todo
  ('owner', 'billing:manage'),
  ('owner', 'settings:manage'),
  ('owner', 'team:assign_scope'),
  ('owner', 'team:grant_capability'),
  ('owner', 'branches:write'),
  ('owner', 'departments:write'),
  ('owner', 'employees:write'),
  ('owner', 'employees:wages_read'),
  ('owner', 'policies:write'),
  ('owner', 'policies:read'),
  ('owner', 'schedule:generate'),
  ('owner', 'schedule:write'),
  ('owner', 'swaps:approve'),
  ('owner', 'absences:approve'),
  ('owner', 'incidents:manage'),
  ('owner', 'dayoffs:approve'),
  ('owner', 'audit:read'),
  -- Manager: operativas + scoped writes
  ('manager', 'departments:write'),
  ('manager', 'employees:write'),
  ('manager', 'policies:read'),
  ('manager', 'schedule:generate'),
  ('manager', 'schedule:write'),
  ('manager', 'swaps:approve'),
  ('manager', 'absences:approve'),
  ('manager', 'incidents:manage'),
  ('manager', 'dayoffs:approve'),
  ('manager', 'audit:read'),
  -- Employee: read-only de lo propio
  ('employee', 'audit:read'),
  ('employee', 'policies:read')
) AS defaults(role, capability)
ON CONFLICT (company_id, role, capability) DO NOTHING;

-- ─── 7. Trigger en companies INSERT → seed defaults automático ─────────
-- Para que self_signup nuevas companies traigan los defaults sin que
-- el código tenga que hacer un INSERT explícito. Idempotente.
CREATE OR REPLACE FUNCTION public.seed_default_role_capabilities()
RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.company_role_capabilities (company_id, role, capability)
  VALUES
    (NEW.id, 'owner', 'billing:manage'),
    (NEW.id, 'owner', 'settings:manage'),
    (NEW.id, 'owner', 'team:assign_scope'),
    (NEW.id, 'owner', 'team:grant_capability'),
    (NEW.id, 'owner', 'branches:write'),
    (NEW.id, 'owner', 'departments:write'),
    (NEW.id, 'owner', 'employees:write'),
    (NEW.id, 'owner', 'employees:wages_read'),
    (NEW.id, 'owner', 'policies:write'),
    (NEW.id, 'owner', 'policies:read'),
    (NEW.id, 'owner', 'schedule:generate'),
    (NEW.id, 'owner', 'schedule:write'),
    (NEW.id, 'owner', 'swaps:approve'),
    (NEW.id, 'owner', 'absences:approve'),
    (NEW.id, 'owner', 'incidents:manage'),
    (NEW.id, 'owner', 'dayoffs:approve'),
    (NEW.id, 'owner', 'audit:read'),
    (NEW.id, 'manager', 'departments:write'),
    (NEW.id, 'manager', 'employees:write'),
    (NEW.id, 'manager', 'policies:read'),
    (NEW.id, 'manager', 'schedule:generate'),
    (NEW.id, 'manager', 'schedule:write'),
    (NEW.id, 'manager', 'swaps:approve'),
    (NEW.id, 'manager', 'absences:approve'),
    (NEW.id, 'manager', 'incidents:manage'),
    (NEW.id, 'manager', 'dayoffs:approve'),
    (NEW.id, 'manager', 'audit:read'),
    (NEW.id, 'employee', 'audit:read'),
    (NEW.id, 'employee', 'policies:read')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_company_seed_capabilities ON public.companies;
CREATE TRIGGER on_company_seed_capabilities
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_role_capabilities();

GRANT INSERT ON public.company_role_capabilities TO postgres;

-- ─── 8. Backfill: migrar departments.manager_employee_id → manager_scopes ─
-- Los managers existentes que están asignados como "primary manager" de
-- un depto se mueven al nuevo modelo como scope explícito sobre ese
-- depto. La columna manager_employee_id queda VIVA por ahora — el código
-- legacy (ManagerScopeService, routing approvals) todavía la lee. La
-- vamos a deprecar gradualmente en sprints siguientes.
INSERT INTO public.manager_scopes (employee_id, scope_type, scope_id)
SELECT d.manager_employee_id, 'department', d.id
FROM public.departments d
WHERE d.manager_employee_id IS NOT NULL
ON CONFLICT (employee_id, scope_type, scope_id) DO NOTHING;

GRANT INSERT, SELECT, DELETE ON public.manager_scopes TO postgres;
GRANT INSERT, SELECT, DELETE, UPDATE ON public.employee_capabilities TO postgres;
