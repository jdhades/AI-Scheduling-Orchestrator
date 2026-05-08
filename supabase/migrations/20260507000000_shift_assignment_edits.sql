-- =============================================================================
-- Audit log de ediciones manuales de shift_assignments (Phase 19 — drag & drop)
-- =============================================================================
-- Cuando el manager arrastra un turno desde el panel a otro empleado/día, el
-- backend hace un UPDATE de la assignment. Sin trazabilidad, perdemos info
-- crítica:
--   - quién editó qué (atribución)
--   - cuándo (compliance)
--   - de dónde a dónde (entender desviaciones del horario LLM-generated)
--
-- Esta tabla NO reemplaza al horario activo (ese sigue en shift_assignments);
-- guarda el delta. Un drag = una row acá.
--
-- Sin foreign key a `shift_assignments` porque queremos preservar el audit
-- aunque la assignment se borre después (ej. regeneración de la semana
-- desde generate_schedule). El `assignment_id` queda como string puro.
-- =============================================================================

CREATE TABLE IF NOT EXISTS shift_assignment_edits (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL,
  assignment_id       UUID NOT NULL,
  edited_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quién editó. NULL hasta que entre JWT auth — dejar permisivo, igual
  -- que el resto de tablas con `created_by`. Cuando entre auth, se
  -- back-fillea desde audit logs externos si hace falta.
  edited_by_user_id   UUID NULL,
  -- Estado anterior (lo que reemplazamos):
  old_employee_id     UUID NOT NULL,
  old_date            DATE NOT NULL,
  -- Estado nuevo:
  new_employee_id     UUID NOT NULL,
  new_date            DATE NOT NULL,
  -- Texto libre opcional. UI puede poner "swap manual", "feedback negativo
  -- de Pablo", etc. Útil para search en compliance.
  reason              TEXT NULL
);

-- Index para queries del tipo "qué editó X en la última semana".
CREATE INDEX IF NOT EXISTS shift_assignment_edits_company_time_idx
  ON shift_assignment_edits (company_id, edited_at DESC);

-- Index para queries del tipo "historial de esta assignment".
CREATE INDEX IF NOT EXISTS shift_assignment_edits_assignment_idx
  ON shift_assignment_edits (assignment_id, edited_at DESC);
