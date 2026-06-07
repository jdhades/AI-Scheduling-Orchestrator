-- MIGRATION: locations (optional multi-site layer under a branch)
--
-- Gated by the tenant feature flag 'locations' (paid add-on). Tenants without
-- it keep using the branch as the single marking point (branches.geofence_*).
-- Tenants with it model multiple physical sites per branch, each with its own
-- MANDATORY geofence (position + coverage radius). Locations participate in
-- timeclock (where to clock in) and scheduling (Phase 3) + fairness (Phase 4).

CREATE TABLE IF NOT EXISTS public.locations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  branch_id         UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,

  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),

  -- Geofence is MANDATORY for a location (unlike branches, where it's optional).
  geofence_lat      DOUBLE PRECISION NOT NULL,
  geofence_lng      DOUBLE PRECISION NOT NULL,
  geofence_radius_m INTEGER NOT NULL CHECK (geofence_radius_m > 0),

  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS locations_company_idx ON public.locations(company_id, is_active);
CREATE INDEX IF NOT EXISTS locations_branch_idx ON public.locations(branch_id, is_active);

-- Unique active name per branch (soft-delete friendly: only active rows collide).
CREATE UNIQUE INDEX IF NOT EXISTS locations_branch_name_unique
  ON public.locations(branch_id, lower(name))
  WHERE is_active;

COMMENT ON TABLE public.locations IS
  'Optional physical sites under a branch (feature flag "locations"). Each has a mandatory geofence. Used for timeclock + location-aware scheduling/fairness.';

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- Any authenticated member of the tenant can read its locations.
CREATE POLICY locations_tenant_read ON public.locations
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.employees WHERE auth_user_id = auth.uid()
    )
  );

-- Owner/manager of the tenant can write.
CREATE POLICY locations_tenant_write ON public.locations
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

CREATE POLICY locations_platform_admin ON public.locations
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());
