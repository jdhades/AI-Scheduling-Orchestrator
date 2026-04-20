-- =============================================================================
-- MIGRATION: 20260415020000_shift_template_target_mode.sql
--
-- Añade `target_mode` a `shift_templates` para que cada tenant exprese la
-- semántica de `required_employees`:
--   'exact'        → cuota estricta (no excedas ni incumplas).
--   'minimum'      → al menos N personas (se permite más).
--   'aspirational' → N es un ideal; se permite menos si hace falta.
--   NULL (default) → el sistema decide la mejor distribución (comportamiento
--                    actual: hint de target, con preferencia por elásticos
--                    para el sobrante).
-- =============================================================================

ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS target_mode TEXT DEFAULT NULL
  CHECK (target_mode IS NULL OR target_mode IN ('exact', 'minimum', 'aspirational'));

COMMENT ON COLUMN shift_templates.target_mode IS
  'Cómo tratar required_employees: exact=cuota estricta, minimum=al menos N, '
  'aspirational=idealmente N, NULL=el sistema distribuye óptimamente.';
