-- =============================================================================
-- MIGRATION: 20260429000000_company_policies_scope.sql
-- =============================================================================
-- Phase 14.1 — Scope a CompanyPolicies.
--
-- Hasta ahora una policy aplicaba implícitamente a TODA la empresa. En
-- producción multi-tenant eso no escala: el manager quiere reglas tipo
-- "el departamento de seguridad descansa 48h entre turnos" o "Pablo no
-- trabaja más de 20h semanales (estudiante)" sin afectar al resto.
--
-- Cambios:
--   1. Columnas scope_type + scope_id (nullable cuando scope_type='company').
--   2. CHECK consistencia: scope_id IS NULL sii scope_type='company'.
--   3. UNIQUE activo por interpreter pasa de (company,interpreter) a
--      (company, scope_type, scope_id, interpreter). Permite coexistir
--      "11h tenant-wide" + "48h dept Seguridad" sin chocar.
-- =============================================================================

ALTER TABLE company_policies
  ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'company'
    CHECK (scope_type IN ('company', 'branch', 'department', 'employee')),
  ADD COLUMN scope_id   UUID;

COMMENT ON COLUMN company_policies.scope_type IS
  'A quién aplica la policy: company (default — toda la empresa), branch (una sucursal), department (un departamento), employee (una persona).';
COMMENT ON COLUMN company_policies.scope_id IS
  'Identificador del target (branch_id / department_id / employee_id). NULL sii scope_type=company.';

ALTER TABLE company_policies
  ADD CONSTRAINT company_policies_scope_consistency
    CHECK (
      (scope_type = 'company' AND scope_id IS NULL)
      OR (scope_type <> 'company' AND scope_id IS NOT NULL)
    );

-- Reemplazar el UNIQUE existente para que el scope sea parte de la clave.
DROP INDEX IF EXISTS company_policies_unique_active_per_interpreter;

-- COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid) para
-- que el UNIQUE funcione con scope_id NULL (caso scope_type='company').
CREATE UNIQUE INDEX company_policies_unique_active_per_scope_interpreter
  ON company_policies(
    company_id,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    interpreter_id
  )
  WHERE deleted_at IS NULL AND interpreter_id IS NOT NULL;

-- Índice para queries del solver: cargar todas las policies activas de un
-- tenant y filtrar in-memory por scope.
CREATE INDEX IF NOT EXISTS company_policies_scope_idx
  ON company_policies(company_id, scope_type, scope_id)
  WHERE deleted_at IS NULL AND is_active = true;
