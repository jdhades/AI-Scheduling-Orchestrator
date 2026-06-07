-- MIGRATION: timeclock (Sprint 2 — GPS + selfie attendance, Phase 1)
--
-- Clock in/out events from the employee mobile app. Phase 1 only uses
-- source='gps' (selfie + lat/lng validated against the branch geofence);
-- nfc/biometric are Phase 2 (schema is extensible so no rewrite needed).
--
-- Idempotency: the client generates a client_uuid before the event leaves
-- the device; UNIQUE (company_id, client_uuid) makes offline retries safe.

-- ─── Geofence config on branches (GPS, Phase 1) ─────────────────────────
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS geofence_lat      DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS geofence_lng      DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS geofence_radius_m INTEGER NULL
    CHECK (geofence_radius_m IS NULL OR geofence_radius_m > 0);

COMMENT ON COLUMN public.branches.geofence_radius_m IS
  'Allowed clock-in radius in meters around (geofence_lat, geofence_lng). NULL = geofence not configured (no GPS gate).';

-- ─── time_clock_events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.time_clock_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  shift_assignment_id UUID NULL REFERENCES public.shift_assignments(id) ON DELETE SET NULL,

  -- Client-generated idempotency key (offline-safe retries).
  client_uuid         UUID NOT NULL,

  type                TEXT NOT NULL
    CHECK (type IN ('in', 'out', 'break_start', 'break_end')),
  source              TEXT NOT NULL DEFAULT 'gps'
    CHECK (source IN ('gps', 'nfc', 'manual', 'biometric')),
  -- { lat, lng, accuracy, photo_url, tag_uid? } — shape varies by source.
  source_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- When the punch happened (captured on device) vs when it reached us.
  occurred_at         TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  validation_status   TEXT NOT NULL DEFAULT 'valid'
    CHECK (validation_status IN ('valid', 'pending_review', 'disputed')),
  -- Why it landed in pending_review (outside_geofence | low_accuracy | ...).
  anomaly_reason      TEXT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotency: a retried offline event with the same client_uuid is a no-op.
  CONSTRAINT time_clock_events_client_uuid_unique UNIQUE (company_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS time_clock_events_employee_idx
  ON public.time_clock_events(employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS time_clock_events_company_idx
  ON public.time_clock_events(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS time_clock_events_review_idx
  ON public.time_clock_events(company_id, validation_status, occurred_at DESC);

COMMENT ON TABLE public.time_clock_events IS
  'Attendance punches (clock in/out, break) from the employee app. Phase 1: GPS + selfie. Idempotent by (company_id, client_uuid).';

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.time_clock_events ENABLE ROW LEVEL SECURITY;

-- Employee: read + write their OWN punches.
CREATE POLICY time_clock_events_own_rw ON public.time_clock_events
  FOR ALL TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );

-- Manager/owner: read the tenant's punches (web review queue).
CREATE POLICY time_clock_events_tenant_read ON public.time_clock_events
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.employees
      WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

-- Platform admin: cross-tenant.
CREATE POLICY time_clock_events_platform_admin ON public.time_clock_events
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());
