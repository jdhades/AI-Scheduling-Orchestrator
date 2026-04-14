-- =============================================================================
-- MIGRATION: 20260413000000_working_time_policies.sql
-- 3-level rule hierarchy for working time limits
--   1. Employee  (highest priority — contractual exceptions)
--   2. Department (e.g. security 12x24, call center 10h shifts)
--   3. Company    (tenant defaults)
-- All columns nullable → null = "inherit from next level up".
-- Fallback when all three are null is hardcoded in WorkingTimePolicyResolver.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- COMPANIES: tenant-level defaults
-- ---------------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_max_hours_per_day  NUMERIC(4,2);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_max_hours_per_week NUMERIC(5,2);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_min_rest_gap_hours NUMERIC(4,2);

-- ---------------------------------------------------------------------------
-- DEPARTMENTS: per-department overrides
-- ---------------------------------------------------------------------------
ALTER TABLE departments ADD COLUMN IF NOT EXISTS max_hours_per_day  NUMERIC(4,2);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS max_hours_per_week NUMERIC(5,2);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS min_rest_gap_hours NUMERIC(4,2);

-- ---------------------------------------------------------------------------
-- EMPLOYEES: per-employee contractual exceptions
-- ---------------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS contract_type      TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS max_hours_per_day  NUMERIC(4,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS max_hours_per_week NUMERIC(5,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS min_rest_gap_hours NUMERIC(4,2);

-- ---------------------------------------------------------------------------
-- Sanity checks
-- ---------------------------------------------------------------------------
ALTER TABLE companies   ADD CONSTRAINT companies_default_max_hours_per_day_chk   CHECK (default_max_hours_per_day  IS NULL OR (default_max_hours_per_day  > 0 AND default_max_hours_per_day  <= 24));
ALTER TABLE companies   ADD CONSTRAINT companies_default_max_hours_per_week_chk  CHECK (default_max_hours_per_week IS NULL OR (default_max_hours_per_week > 0 AND default_max_hours_per_week <= 168));
ALTER TABLE companies   ADD CONSTRAINT companies_default_min_rest_gap_hours_chk  CHECK (default_min_rest_gap_hours IS NULL OR (default_min_rest_gap_hours >= 0 AND default_min_rest_gap_hours <= 24));

ALTER TABLE departments ADD CONSTRAINT departments_max_hours_per_day_chk   CHECK (max_hours_per_day  IS NULL OR (max_hours_per_day  > 0 AND max_hours_per_day  <= 24));
ALTER TABLE departments ADD CONSTRAINT departments_max_hours_per_week_chk  CHECK (max_hours_per_week IS NULL OR (max_hours_per_week > 0 AND max_hours_per_week <= 168));
ALTER TABLE departments ADD CONSTRAINT departments_min_rest_gap_hours_chk  CHECK (min_rest_gap_hours IS NULL OR (min_rest_gap_hours >= 0 AND min_rest_gap_hours <= 24));

ALTER TABLE employees   ADD CONSTRAINT employees_max_hours_per_day_chk   CHECK (max_hours_per_day  IS NULL OR (max_hours_per_day  > 0 AND max_hours_per_day  <= 24));
ALTER TABLE employees   ADD CONSTRAINT employees_max_hours_per_week_chk  CHECK (max_hours_per_week IS NULL OR (max_hours_per_week > 0 AND max_hours_per_week <= 168));
ALTER TABLE employees   ADD CONSTRAINT employees_min_rest_gap_hours_chk  CHECK (min_rest_gap_hours IS NULL OR (min_rest_gap_hours >= 0 AND min_rest_gap_hours <= 24));

COMMENT ON COLUMN companies.default_max_hours_per_day  IS 'Tenant-level default for daily hour cap. NULL = use system fallback.';
COMMENT ON COLUMN companies.default_max_hours_per_week IS 'Tenant-level default for weekly hour cap. NULL = use system fallback.';
COMMENT ON COLUMN companies.default_min_rest_gap_hours IS 'Tenant-level default for minimum rest hours between shifts. NULL = use system fallback.';

COMMENT ON COLUMN departments.max_hours_per_day  IS 'Department override. NULL = inherit from company.';
COMMENT ON COLUMN departments.max_hours_per_week IS 'Department override. NULL = inherit from company.';
COMMENT ON COLUMN departments.min_rest_gap_hours IS 'Department override. NULL = inherit from company.';

COMMENT ON COLUMN employees.contract_type      IS 'Free-text contract identifier (e.g. "full-time", "part-time", "12x24").';
COMMENT ON COLUMN employees.max_hours_per_day  IS 'Per-employee override. NULL = inherit from department/company.';
COMMENT ON COLUMN employees.max_hours_per_week IS 'Per-employee override. NULL = inherit from department/company.';
COMMENT ON COLUMN employees.min_rest_gap_hours IS 'Per-employee override. NULL = inherit from department/company.';
