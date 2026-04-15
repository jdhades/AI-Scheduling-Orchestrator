-- =============================================================================
-- MIGRATION: 20260415000000_allow_overnight_templates.sql
--
-- Permite templates que cruzan medianoche (end_time <= start_time). El
-- generador de slots (ShiftSlotGeneratorService) ya maneja el roll-over a
-- las 24h al materializar el slot — el check a nivel TIME era demasiado
-- restrictivo y bloqueaba los turnos de noche ("22:00 → 06:00").
-- =============================================================================

-- El constraint fue creado sin nombre explícito; viene como shift_templates_check.
ALTER TABLE shift_templates DROP CONSTRAINT IF EXISTS shift_templates_check;

COMMENT ON COLUMN shift_templates.end_time IS
  'Hora de fin del turno en formato TIME. Si end_time <= start_time, el turno '
  'cruza medianoche (ej. 22:00 → 06:00); el generador de slots materializa el '
  'slot con endTime = startTime + duración correcta.';
