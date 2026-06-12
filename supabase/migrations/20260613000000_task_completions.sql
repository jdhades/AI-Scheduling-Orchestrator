-- MIGRATION: task_completions + flags de enforcement del check.
--
-- Fase E (tareas con reinicio diario):
--   - La definición de la tarea (tabla `tasks`) se queda igual (título +
--     target template|employee). Lo que cambia es el COMPLETADO: pasa a ser
--     POR DÍA (reinicio diario implícito) en vez del booleano permanente
--     `is_done`.
--   - `task_completions` guarda una fila por (tarea, día). Una tarea está
--     "hecha hoy" si existe la fila de hoy; mañana arranca limpia.
--   - Tarea de turno (template) = COMPARTIDA: UNIQUE(task_id, date) → el
--     primero que la cierra la marca hecha para todos los del turno ese día.
--
-- Enforcement configurable por el manager (default estricto):
--   - task_check_require_on_shift: el empleado debe estar fichado.
--   - task_check_require_on_site : debe estar dentro del geofence.

CREATE TABLE IF NOT EXISTS public.task_completions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL,
  task_id       UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  -- Día lógico del completado (YYYY-MM-DD en la tz del empleado).
  date          DATE NOT NULL,
  completed_by_employee_id UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una sola por (tarea, día): la de turno es compartida; la de empleado es
  -- de ese empleado. En ambos casos un check por día.
  CONSTRAINT task_completions_unique_per_day UNIQUE (task_id, date)
);

CREATE INDEX IF NOT EXISTS task_completions_task_date_idx
  ON public.task_completions(task_id, date);
CREATE INDEX IF NOT EXISTS task_completions_company_date_idx
  ON public.task_completions(company_id, date);

ALTER TABLE public.task_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.task_completions
  FOR ALL TO authenticated
  USING (company_id = public.user_company_id())
  WITH CHECK (company_id = public.user_company_id());

COMMENT ON TABLE public.task_completions IS
  'Completado por día de una tarea (reinicio diario). UNIQUE(task_id, date) → la tarea de turno es compartida entre quienes la cubren ese día.';

-- Flags de enforcement del check (default estricto: fichado + en el sitio).
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS task_check_require_on_shift BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS task_check_require_on_site  BOOLEAN NOT NULL DEFAULT true;
