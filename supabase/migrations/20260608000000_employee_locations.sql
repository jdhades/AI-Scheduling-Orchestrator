-- MIGRATION: employee ↔ location affinity (Locations feature, Phase 2)
--
-- Per-employee: a set of allowed locations + a mode (fixed | rotate).
--   fixed  → the employee always works the same location (scheduler keeps them).
--   rotate → the scheduler balances them across their allowed locations.
-- Used by timeclock (which location's geofence to validate) + scheduling
-- (Phase 3) + fairness (Phase 4). Only meaningful when the tenant has the
-- 'locations' feature flag on.

-- Per-employee mode (default rotate; harmless for branch-only tenants).
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS location_mode TEXT NOT NULL DEFAULT 'rotate'
    CHECK (location_mode IN ('fixed', 'rotate'));

-- Allowed locations (M:N).
CREATE TABLE IF NOT EXISTS public.employee_locations (
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, location_id)
);

CREATE INDEX IF NOT EXISTS employee_locations_company_idx ON public.employee_locations(company_id);
CREATE INDEX IF NOT EXISTS employee_locations_location_idx ON public.employee_locations(location_id);

COMMENT ON TABLE public.employee_locations IS
  'Allowed locations per employee (Locations feature). Combined with employees.location_mode (fixed|rotate).';

-- Which location a punch was made at (resolved from the shift/location).
ALTER TABLE public.time_clock_events
  ADD COLUMN IF NOT EXISTS location_id UUID NULL REFERENCES public.locations(id) ON DELETE SET NULL;

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.employee_locations ENABLE ROW LEVEL SECURITY;

-- Employee reads their OWN allowed locations (mobile picker).
CREATE POLICY employee_locations_own_read ON public.employee_locations
  FOR SELECT TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );

-- Owner/manager of the tenant reads + writes.
CREATE POLICY employee_locations_tenant_write ON public.employee_locations
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.employees
      WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM public.employees
      WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

CREATE POLICY employee_locations_platform_admin ON public.employee_locations
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());
