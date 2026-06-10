-- MIGRATION: timeclock corrections — capability + audit entity type
--
-- F4a del módulo de marcaciones. Habilita correcciones de fichajes:
--   1. nueva capability `timeclock:correct` (default owner+manager), seedeada
--      para las companies existentes.
--   2. `time_clock_event` como entity_type del audit log (correcciones logueadas).

-- 1. Audit: permitir time_clock_event.
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
    'shift_membership',
    'time_clock_event'
  ));

-- 2. Seed de la capability para owner + manager en todas las companies.
INSERT INTO public.company_role_capabilities (company_id, role, capability)
SELECT c.id, r.role, 'timeclock:correct'
FROM public.companies c
CROSS JOIN (VALUES ('owner'), ('manager')) AS r(role)
ON CONFLICT (company_id, role, capability) DO NOTHING;
