-- MIGRATION: entity_audit_log — agregar 'rule' al CHECK constraint.
--
-- Sprint history-UI: extender el subsistema de auditoría a las reglas
-- semánticas (CRUD desde RulesPage + LLM workers). El frontend va a
-- mostrar el botón "Historial" en cada regla.
--
-- Postgres no permite ALTER CHECK directamente sobre un constraint con
-- CHECK inline: hay que DROP + ADD. El nombre del constraint lo asigna
-- Postgres automáticamente (entity_audit_log_entity_type_check) cuando
-- se usa CHECK inline en CREATE TABLE.

ALTER TABLE public.entity_audit_log
  DROP CONSTRAINT entity_audit_log_entity_type_check;

ALTER TABLE public.entity_audit_log
  ADD CONSTRAINT entity_audit_log_entity_type_check
  CHECK (entity_type IN (
    'shift_assignment',
    'shift_template',
    'employee',
    'company_policy',
    'rule'
  ));

COMMENT ON TABLE public.entity_audit_log IS
  'Historial de cambios sobre entidades editables (v2: + rule). Logueado por AuditService desde la app.';
