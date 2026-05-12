-- =============================================================================
-- Audit time fields para resize de turnos (Phase 19E.3)
-- =============================================================================
-- El mover original solo cambiaba (employee, date). Con resize / shrink /
-- stretch en Week/Day view, ahora también cambian actualStartTime y
-- actualEndTime. Agregamos columnas en el audit para no perder esa
-- información — un manager puede mover Y achicar el turno en un solo PATCH.
--
-- Nullable porque rows viejos (pre-resize) no las tienen, y en moves que NO
-- cambian times tampoco se setean.
-- =============================================================================

ALTER TABLE shift_assignment_edits
  ADD COLUMN IF NOT EXISTS old_actual_start_time TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS old_actual_end_time   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS new_actual_start_time TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS new_actual_end_time   TIMESTAMPTZ NULL;
