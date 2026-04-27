-- Adds external_id to employees: an opaque string the company uses in their
-- payroll / attendance system. Distinct from the internal UUID PK so that two
-- companies (or two imports) can collide on legajo without breaking joins.
ALTER TABLE employees ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX employees_external_id_per_company
  ON employees(company_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN employees.external_id IS
  'Optional company-side identifier (legajo / payroll id). Unique per active employee within a tenant.';
