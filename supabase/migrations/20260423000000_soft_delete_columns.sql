-- =============================================================================
-- MIGRATION: 20260423000000_soft_delete_columns.sql
-- Columnas uniformes de soft-delete sobre las entidades con CRUD del manager.
--   - is_active  : toggle lógico (reversible) — ya existía en shift_templates y
--                  semantic_rules; se suma a las restantes.
--   - deleted_at : timestamp del borrado lógico (reversible si se vuelve a NULL).
-- Ambas columnas conviven: el UI puede mostrar "Inactivo" (is_active=false) vs
-- "Eliminado" (deleted_at IS NOT NULL) según el caso.
-- Las consultas del dominio (builder, retrieval, etc.) deben filtrar por
-- `is_active = true AND deleted_at IS NULL` para ignorar borrados.
-- =============================================================================

-- employees: no tenía ninguno de los dos
ALTER TABLE employees        ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT true;
ALTER TABLE employees        ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

-- shift_templates: ya tenía is_active, solo falta deleted_at
ALTER TABLE shift_templates  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

-- shift_memberships: vínculo empleado↔template
ALTER TABLE shift_memberships ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT true;
ALTER TABLE shift_memberships ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- company_skills: catálogo per-tenant
ALTER TABLE company_skills   ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT true;
ALTER TABLE company_skills   ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

-- semantic_rules: ya tiene is_active + expires_at, solo falta deleted_at
ALTER TABLE semantic_rules   ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

-- Índices auxiliares para filtros habituales
CREATE INDEX IF NOT EXISTS employees_company_active_idx
  ON employees(company_id, is_active)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS shift_memberships_company_active_idx
  ON shift_memberships(company_id, is_active)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS company_skills_company_active_idx
  ON company_skills(company_id, is_active)
  WHERE deleted_at IS NULL;
