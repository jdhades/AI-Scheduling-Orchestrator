-- MIGRATION: tasks — subsistema de tareas por dept / user / shift.
--
-- Decisiones del sprint Tasks (2026-05-19):
--   - Una tarea pertenece a EXACTAMENTE 1 target: departamento,
--     empleado, o shift_assignment (intra-shift). CHECK constraint
--     enforce esto a nivel DB.
--   - 3 columnas FK separadas (department_id, employee_id,
--     shift_assignment_id) en lugar de (assignee_type, assignee_id)
--     polimórfico — permite ON DELETE CASCADE real y queries
--     indexadas por target.
--   - completed_by_employee_id audita quién cerró (no quién creó —
--     eso lo cubre history en F3).
--   - Sin recurrencia ni approval flow en v1 (1-off + close directo).
--   - Sin priority/deadline en v1 — sumar si aparece caso real.

CREATE TABLE IF NOT EXISTS public.tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL,
  title         TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 200),
  description   TEXT NULL CHECK (description IS NULL OR length(description) <= 2000),
  is_done       BOOLEAN NOT NULL DEFAULT false,
  -- Exactamente 1 de los 3 targets debe ser NOT NULL (CHECK abajo).
  department_id         UUID NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  employee_id           UUID NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  shift_assignment_id   UUID NULL REFERENCES public.shift_assignments(id) ON DELETE CASCADE,
  -- Audit minimal — quién la cerró. created_by queda para history (F3).
  completed_at          TIMESTAMPTZ NULL,
  completed_by_employee_id  UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_exactly_one_target CHECK (
    (department_id IS NOT NULL)::int +
    (employee_id IS NOT NULL)::int +
    (shift_assignment_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT tasks_completed_consistency CHECK (
    (is_done = false AND completed_at IS NULL) OR
    (is_done = true AND completed_at IS NOT NULL)
  )
);

-- Index por target — listados típicos: "tareas del empleado X",
-- "tareas del depto Y", "tareas del shift Z".
CREATE INDEX IF NOT EXISTS tasks_department_idx
  ON public.tasks(department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_employee_idx
  ON public.tasks(employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_shift_assignment_idx
  ON public.tasks(shift_assignment_id) WHERE shift_assignment_id IS NOT NULL;

-- Index company + is_done para "tareas pendientes del tenant" (dashboard).
CREATE INDEX IF NOT EXISTS tasks_company_done_idx
  ON public.tasks(company_id, is_done);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.tasks
  FOR ALL TO authenticated
  USING (company_id = auth.user_company_id())
  WITH CHECK (company_id = auth.user_company_id());

COMMENT ON TABLE public.tasks IS
  'Tareas por target único (dept | employee | shift assignment). MVP: title + done flag + creator/closer audit. Sin recurrencia ni approval workflow.';
