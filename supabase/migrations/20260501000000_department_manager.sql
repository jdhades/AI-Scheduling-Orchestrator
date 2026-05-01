-- =============================================================================
-- Department manager — manager_employee_id (Phase 15.1)
-- =============================================================================
-- Cada departamento puede tener un employee designado como "manager":
-- el destinatario por defecto de approvals (swap requests, absences,
-- incident reports, day-off requests) que originen empleados del depto.
--
-- Nullable: si está vacío, el routing actual (cualquier manager del tenant)
-- sigue activo como fallback. Eso preserva el comportamiento del seed
-- legacy (un único Marco Manager para todo el tenant).
--
-- ON DELETE SET NULL: si se borra al employee designado, el depto queda
-- sin manager asignado y cae al fallback. NO bloquea el delete.
-- =============================================================================

ALTER TABLE departments
ADD COLUMN manager_employee_id UUID NULL
  REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_departments_manager_employee_id
  ON departments(manager_employee_id)
  WHERE manager_employee_id IS NOT NULL;

COMMENT ON COLUMN departments.manager_employee_id IS
  'Employee (con role=manager) designado como manager del departamento. '
  'Receptor por defecto de approvals (swap/absence/incident/day-off) '
  'originados por empleados del depto. NULL = fallback a cualquier manager '
  'del tenant.';
