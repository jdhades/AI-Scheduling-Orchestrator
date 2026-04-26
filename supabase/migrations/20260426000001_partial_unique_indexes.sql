-- Replace the global UNIQUE constraints (and their auto-generated indexes)
-- with partial UNIQUE indexes that ignore soft-deleted rows. Same root cause
-- as the phone fix in 20260426000000: DELETE soft-marks the row but leaves
-- it in the table, then re-creating with the same key combination violates
-- the global UNIQUE → 500/409.
--
-- Targets:
--   - shift_memberships_employee_id_template_id_effective_from_key
--       blocks re-creating a deleted membership for the same
--       (employee, template, effective_from).
--   - company_skills_company_id_skill_id_key
--       blocks re-adding a deleted skill to a tenant catalog.
--
-- Naming: dropped the `_key` suffix on recreate. Postgres reserves that
-- suffix for index-backed UNIQUE constraints; the new partial UNIQUE INDEX
-- is not a constraint, so a non-_key name avoids confusion in pg_constraint.

ALTER TABLE shift_memberships
  DROP CONSTRAINT IF EXISTS shift_memberships_employee_id_template_id_effective_from_key;

CREATE UNIQUE INDEX shift_memberships_unique_active_per_emp_tpl_from
  ON shift_memberships(employee_id, template_id, effective_from)
  WHERE deleted_at IS NULL;

ALTER TABLE company_skills
  DROP CONSTRAINT IF EXISTS company_skills_company_id_skill_id_key;

CREATE UNIQUE INDEX company_skills_unique_active_per_company_skill
  ON company_skills(company_id, skill_id)
  WHERE deleted_at IS NULL;
