-- =============================================================================
-- MIGRATION: drop min_rest_gap_hours columns.
-- Las empresas solo manejan caps de horas diarias y semanales.
-- =============================================================================

ALTER TABLE companies   DROP CONSTRAINT IF EXISTS companies_default_min_rest_gap_hours_chk;
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_min_rest_gap_hours_chk;
ALTER TABLE employees   DROP CONSTRAINT IF EXISTS employees_min_rest_gap_hours_chk;

ALTER TABLE companies   DROP COLUMN IF EXISTS default_min_rest_gap_hours;
ALTER TABLE departments DROP COLUMN IF EXISTS min_rest_gap_hours;
ALTER TABLE employees   DROP COLUMN IF EXISTS min_rest_gap_hours;
