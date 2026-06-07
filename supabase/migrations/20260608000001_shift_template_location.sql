-- MIGRATION: shift_templates.location_id (Locations feature, Phase 3)
--
-- The location a template's shifts take place at. Null = no specific location
-- (branch-level / location feature off). When set + the 'locations' flag is on,
-- the scheduler only assigns employees whose allowed-location set includes it,
-- and it drives the timeclock geofence + fairness rotation.

ALTER TABLE public.shift_templates
  ADD COLUMN IF NOT EXISTS location_id UUID NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS shift_templates_location_idx
  ON public.shift_templates(location_id)
  WHERE location_id IS NOT NULL;
