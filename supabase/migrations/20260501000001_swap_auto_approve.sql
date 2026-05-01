-- =============================================================================
-- Swap auto-approve toggle (Phase 15.3)
-- =============================================================================
-- Cada departamento puede activar `swap_auto_approve` para que sus swap
-- requests no requieran aprobación manual del manager. El flag vive a
-- nivel depto porque cada manager controla la política de su equipo:
-- Retail puede confiar en sus 10 empleados, Seguridad puede exigir
-- aprobación por compliance.
--
-- Default `false` preserva el comportamiento legacy (manager aprueba todo).
--
-- `shift_swap_requests.approved_by` es NULL para v1 cuando aprueba el
-- manager (no hay auth todavía → no podemos identificar qué manager).
-- Solo lo seteamos para `system:auto-approve` cuando el flag dispara, así
-- el panel puede mostrar "auto" en la columna y diferenciar audit-wise.
-- =============================================================================

ALTER TABLE departments
ADD COLUMN swap_auto_approve BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN departments.swap_auto_approve IS 'Si true, los shift_swap_requests originados por empleados del depto se aprueban automaticamente (status=accepted, approved_by=system:auto-approve) sin esperar al manager. Default false.';

ALTER TABLE shift_swap_requests
ADD COLUMN approved_by TEXT NULL;

COMMENT ON COLUMN shift_swap_requests.approved_by IS 'Quien aprobo/rechazo el request. v1: system:auto-approve (depto con auto-approve on). NULL para approvals manuales hasta que tengamos JWT y podamos persistir el manager UUID.';
