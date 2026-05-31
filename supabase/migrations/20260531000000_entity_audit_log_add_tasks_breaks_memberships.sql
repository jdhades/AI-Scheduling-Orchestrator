-- MIGRATION: entity_audit_log — agregar task, shift_assignment_break,
-- shift_membership al CHECK constraint.
--
-- Sprint history cross-cutting (close-out): extender el subsistema de
-- auditoría a las 3 sub-entities del schedule que faltaban. Hoy el
-- audit log captura assignments/templates/employees/policies/rules,
-- pero los cambios sobre tasks (subsistema de tareas), breaks
-- (descansos intra-shift) y memberships (turnos recurrentes) no se
-- registraban.
--
-- Sigue el mismo pattern que el sprint history-UI (rule) — DROP +
-- ADD del CHECK constraint.

ALTER TABLE public.entity_audit_log
  DROP CONSTRAINT entity_audit_log_entity_type_check;

ALTER TABLE public.entity_audit_log
  ADD CONSTRAINT entity_audit_log_entity_type_check
  CHECK (entity_type IN (
    'shift_assignment',
    'shift_template',
    'employee',
    'company_policy',
    'rule',
    'task',
    'shift_assignment_break',
    'shift_membership'
  ));

COMMENT ON TABLE public.entity_audit_log IS
  'Historial de cambios sobre entidades editables (v3: + task, shift_assignment_break, shift_membership). Logueado por AuditService desde la app.';
