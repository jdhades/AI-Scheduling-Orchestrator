-- MIGRATION: shift_assignments.confirmed_at — timestamp en que el
-- empleado marcó "leí mi turno". Solo se usa cuando la preferencia
-- de la company `shift_confirmation_required` está activa. NULL =
-- no confirmado todavía (o el flag estaba off cuando se generó).

ALTER TABLE public.shift_assignments
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.shift_assignments.confirmed_at IS
  'Timestamp cuando el empleado confirmó que leyó el turno. NULL = no confirmado o flag company.shift_confirmation_required en off.';

-- Index parcial: queries típicas filtran "los míos sin confirmar".
-- Solo indexamos rows NULL — la cardinalidad de los confirmados crece
-- mucho más rápido y no necesita lookup.
CREATE INDEX IF NOT EXISTS shift_assignments_unconfirmed_idx
  ON public.shift_assignments (employee_id)
  WHERE confirmed_at IS NULL;
