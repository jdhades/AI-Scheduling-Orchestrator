-- MIGRATION: refactor tasks targets.
--
-- Cambio de modelo (decisión 2026-05-20):
--   - DROP   department_id        — el target depto no aplicaba al uso real.
--   - DROP   shift_assignment_id  — tareas por instancia puntual eran demasiado
--                                   granulares; el manager las quería por
--                                   "concepto turno", no por día específico.
--   - ADD    shift_template_id    — cualquier empleado que cubra ese template
--                                   hereda esas tareas automáticamente.
--
-- Resultado: una tarea pertenece a EXACTAMENTE 1 target — template o employee.
--
-- IMPORTANTE — pérdida de data: esta migration BORRA todas las tareas
-- existentes. Aceptable solo porque local dev no tiene data productiva.
-- En prod habría que pensar migración por tipo: para shift_assignment_id,
-- mapear a su template_id; para department_id y employee_id se preservan
-- (el primer caso pierde el target, el segundo queda igual).

DELETE FROM public.tasks;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_exactly_one_target;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS department_id;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS shift_assignment_id;

DROP INDEX IF EXISTS tasks_department_idx;
DROP INDEX IF EXISTS tasks_shift_assignment_idx;
DROP INDEX IF EXISTS tasks_employee_idx;

ALTER TABLE public.tasks
  ADD COLUMN shift_template_id UUID NULL
    REFERENCES public.shift_templates(id) ON DELETE CASCADE;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_exactly_one_target CHECK (
    (shift_template_id IS NOT NULL)::int +
    (employee_id IS NOT NULL)::int = 1
  );

CREATE INDEX IF NOT EXISTS tasks_template_idx
  ON public.tasks(shift_template_id) WHERE shift_template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_employee_idx
  ON public.tasks(employee_id) WHERE employee_id IS NOT NULL;

COMMENT ON TABLE public.tasks IS
  'Tareas por template (turno como concepto) o por empleado. Los empleados heredan las tareas del template del turno que están cubriendo.';
