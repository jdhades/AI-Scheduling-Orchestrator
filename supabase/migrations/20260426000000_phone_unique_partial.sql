-- Convert the (company_id, phone_number) UNIQUE index on employees into a
-- partial index that ignores soft-deleted rows. The original index from the
-- initial schema (20240301) was global, which meant that after a soft-delete
-- (DELETE /employees/:id sets deleted_at = NOW()) the row stayed in the table
-- and re-creating an employee with the same phone number triggered a
-- unique_violation (Postgres 23505) — surfaced to the manager as 500.
--
-- The external_id index added in 20260425 already followed this pattern; this
-- migration just brings phone_number into line.
DROP INDEX IF EXISTS employees_phone_company_idx;

CREATE UNIQUE INDEX employees_phone_company_idx
  ON employees(company_id, phone_number)
  WHERE deleted_at IS NULL;
