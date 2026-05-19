-- MIGRATION: entity_audit_log — historial cross-cutting.
--
-- Captura cambios sobre entidades editables que el usuario quiere ver
-- en un "Historial" dentro de los edit dialogs.
--
-- Scope inicial (v1):
--   - shift_assignment (turnos asignados — drag/drop, edit, delete)
--   - shift_template   (templates de horario)
--   - employee         (datos del empleado)
--   - company_policy   (policies por tenant)
--
-- El AuditService de la app loguea explícitamente desde cada controller.
-- Triggers DB-level quedan como follow-up (necesitan GUC per-request
-- para identificar al actor cuando se usa SERVICE_ROLE_KEY).
--
-- `changes` es un JSONB con shape `{ "field": { "before": <val>, "after": <val> } }`.
-- Solo se loguean los campos editables (no metadata como id/created_at).

CREATE TABLE IF NOT EXISTS public.entity_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  entity_type     TEXT NOT NULL CHECK (entity_type IN (
    'shift_assignment',
    'shift_template',
    'employee',
    'company_policy'
  )),
  entity_id       UUID NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  changes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Actor: `actor_user_id` viene del JWT (Supabase auth.users.id).
  -- `actor_employee_id` es el employee linked al user, cuando aplica.
  -- En path DEV_AUTH_BYPASS ambos quedan null — el log se conserva
  -- pero sin actor (acceptable bridge hasta que JWT esté en prod).
  actor_user_id       UUID NULL,
  actor_employee_id   UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Listado típico: "historial de la entidad X ordenado por fecha desc".
CREATE INDEX IF NOT EXISTS entity_audit_log_entity_idx
  ON public.entity_audit_log(company_id, entity_type, entity_id, changed_at DESC);

-- "Toda la actividad del tenant" — dashboard / reports futuros.
CREATE INDEX IF NOT EXISTS entity_audit_log_company_changed_idx
  ON public.entity_audit_log(company_id, changed_at DESC);

ALTER TABLE public.entity_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.entity_audit_log
  FOR ALL TO authenticated
  USING (company_id = public.user_company_id())
  WITH CHECK (company_id = public.user_company_id());

COMMENT ON TABLE public.entity_audit_log IS
  'Historial de cambios sobre entidades editables (v1: shift_assignment, shift_template, employee, company_policy). Logueado por AuditService desde la app.';
