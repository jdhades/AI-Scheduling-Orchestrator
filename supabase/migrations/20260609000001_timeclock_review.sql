-- MIGRATION: timeclock review audit (manager review queue)
--
-- Managers approve/reject punches that landed in 'pending_review' (GPS outside
-- the geofence or low accuracy). Approve → validation_status='valid',
-- reject → 'disputed' (both already in the CHECK enum). These columns record
-- who reviewed it, when, and an optional note.

ALTER TABLE public.time_clock_events
  ADD COLUMN IF NOT EXISTS reviewed_by  UUID NULL
    REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS review_note  TEXT NULL;
