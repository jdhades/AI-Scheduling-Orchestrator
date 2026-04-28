-- =============================================================================
-- MIGRATION: semantic rule structure (pre-extracted by LLM at creation time)
-- Evita hacer NLP con regex en runtime. Al crear/editar una regla, un LLM
-- la analiza UNA VEZ y guarda la estructura {intent, employeeMatchers,
-- dateMatchers, shiftTypeMatchers}. En runtime, un resolver traduce esa
-- estructura a {employeeId, shiftId} concretos dados los empleados y shifts
-- de la semana.
-- =============================================================================

ALTER TABLE semantic_rules ADD COLUMN IF NOT EXISTS structure JSONB;

COMMENT ON COLUMN semantic_rules.structure IS
  'LLM-extracted structured form of rule_text. NULL = extraction failed or not run yet. Shape: {intent, employeeMatchers[], dateMatchers[], shiftTypeMatchers[]?, complexReason?}';
