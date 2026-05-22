-- MIGRATION: shift_preferences — hints positivos del empleado.
--
-- A diferencia de day_off_requests (workflow de aprobación) y
-- absence_reports (estado: no fui), este es un canal SUAVE de
-- comunicación employee → solver:
--   • prefer_to_work        → me gustaría tomar turnos el día X
--   • available_hours       → puedo de 09 a 17 los martes
--   • prefer_specific_shift → preferiría este template
--
-- El manager los VE (le llega notificación) pero no necesita
-- aprobarlos. El solver los usa como hint, no como hard constraint.

CREATE TABLE IF NOT EXISTS public.shift_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  -- Tipo del hint.
  kind          TEXT NOT NULL CHECK (kind IN ('prefer_to_work', 'available_hours', 'prefer_specific_shift')),
  -- Fecha del día concreto (YYYY-MM-DD). NULL solo si `repeats_weekday`
  -- está set (preferencia recurrente sin fecha puntual).
  date          DATE NULL,
  -- Recurrencia opcional por día de semana (0=domingo, 6=sábado).
  -- NULL = preferencia de un día puntual; set = aplica todos los días
  -- de la semana de ese weekday hasta `repeats_until` (o indefinido).
  repeats_weekday SMALLINT NULL CHECK (repeats_weekday IS NULL OR (repeats_weekday BETWEEN 0 AND 6)),
  repeats_until DATE NULL,
  -- Ventana horaria (solo aplica a kind='available_hours'). NULL = "todo el día".
  start_time    TIME NULL,
  end_time      TIME NULL,
  -- Solo para kind='prefer_specific_shift'.
  shift_template_id UUID NULL REFERENCES public.shift_templates(id) ON DELETE SET NULL,
  -- Nota libre opcional del empleado.
  note          TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Consistencia: o date o repeats_weekday, alguno de los dos.
  CONSTRAINT shift_preferences_target_ck CHECK (
    date IS NOT NULL OR repeats_weekday IS NOT NULL
  ),
  -- available_hours requiere ventana horaria.
  CONSTRAINT shift_preferences_hours_ck CHECK (
    kind != 'available_hours' OR (start_time IS NOT NULL AND end_time IS NOT NULL)
  ),
  -- prefer_specific_shift requiere template.
  CONSTRAINT shift_preferences_template_ck CHECK (
    kind != 'prefer_specific_shift' OR shift_template_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS shift_preferences_employee_date_idx
  ON public.shift_preferences (employee_id, date);
CREATE INDEX IF NOT EXISTS shift_preferences_company_date_idx
  ON public.shift_preferences (company_id, date);

COMMENT ON TABLE public.shift_preferences IS
  'Hints suaves del empleado al solver y notificación informativa al manager. No requieren aprobación.';

-- RLS
ALTER TABLE public.shift_preferences ENABLE ROW LEVEL SECURITY;

-- Empleado ve y gestiona SOLO las suyas.
CREATE POLICY shift_preferences_employee_self ON public.shift_preferences
  FOR ALL TO authenticated
  USING (
    employee_id IN (
      SELECT id FROM public.employees WHERE auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    employee_id IN (
      SELECT id FROM public.employees WHERE auth_user_id = auth.uid()
    )
  );

-- Manager/owner del tenant ve todas las del depto en su scope (la
-- evaluación detallada de scope vive en el controller; acá basta
-- el filter por company del manager).
CREATE POLICY shift_preferences_manager_read ON public.shift_preferences
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.employees
      WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_preferences TO postgres;
