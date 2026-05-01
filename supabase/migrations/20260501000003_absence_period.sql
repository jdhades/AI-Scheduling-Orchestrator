-- =============================================================================
-- Absence reports → period model (Phase 17.1)
-- =============================================================================
-- absence_reports antes era "no voy a ESTE turno puntual" (apuntaba al
-- shift_assignment_id). El modelo nuevo cubre 2 casos:
--
--   - Single-day:   start_date = end_date = (turno o fecha avisada).
--   - Multi-day:    start_date < end_date (ej. reposo médico de 4 días).
--
-- Ausencias *parciales* (faltar 4 horas el martes) NO viven acá — son
-- del tipo "cambiar hora de entrada/salida" y se manejan via semantic
-- rules. Acá solo es día completo.
--
-- Backfill: para los reportes existentes con shift_assignment_id, las
-- fechas se derivan del shift_assignments.date al hacer el join. Para
-- los reportes manuales que ya están en BD, default a reported_at::date
-- (el día que se persistió). Eso preserva continuidad.
--
-- soft-delete via deleted_at (mismo patrón de otras entidades).
-- =============================================================================

-- 1. Nuevas columnas (start_date NOT NULL después del backfill).
ALTER TABLE absence_reports
  ADD COLUMN start_date DATE NULL,
  ADD COLUMN end_date   DATE NULL,
  ADD COLUMN deleted_at TIMESTAMPTZ NULL;

-- 2. Backfill desde el shift_assignments cuando hay shift_assignment_id.
UPDATE absence_reports a
SET start_date = sa.date,
    end_date   = sa.date
FROM shift_assignments sa
WHERE a.shift_assignment_id = sa.id
  AND a.start_date IS NULL;

-- 3. Backfill restante (reportes sin assignment): usar reported_at.
UPDATE absence_reports
SET start_date = reported_at::date,
    end_date   = reported_at::date
WHERE start_date IS NULL;

-- 4. Ya están todas pobladas: enforced NOT NULL para los nuevos.
ALTER TABLE absence_reports
  ALTER COLUMN start_date SET NOT NULL,
  ALTER COLUMN end_date   SET NOT NULL;

-- 5. Sanity check: end_date >= start_date.
ALTER TABLE absence_reports
  ADD CONSTRAINT absence_reports_period_ck
  CHECK (end_date >= start_date);

-- 6. Index para queries del scheduler ("absences activas en este range").
CREATE INDEX IF NOT EXISTS absence_reports_company_period_idx
  ON absence_reports (company_id, start_date, end_date)
  WHERE deleted_at IS NULL;
