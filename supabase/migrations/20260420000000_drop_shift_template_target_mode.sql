-- =============================================================================
-- MIGRATION: 20260420000000_drop_shift_template_target_mode.sql
--
-- Reverte `target_mode` añadido en 20260415020000. La evidencia de los smokes
-- mostró que el modo es tuning de prompt disfrazado de config de negocio:
-- con el wording correcto ("OBJETIVO EXACTO N" vs "ELÁSTICO") el LLM entiende
-- sin necesidad de un campo extra. La columna se retira para no arrastrar
-- configuración que no aporta.
-- =============================================================================

ALTER TABLE shift_templates DROP COLUMN IF EXISTS target_mode;
