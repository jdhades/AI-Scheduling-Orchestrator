-- MIGRATION: timeclock_correction_requests (F4c)
--
-- Solicitudes de corrección de fichajes: un empleado (o un manager sin el permiso
-- timeclock:correct) propone agregar/editar un marcaje con una razón. Cae a la
-- cola de review; quien tiene timeclock:correct la aplica (crea/edita el evento)
-- o la rechaza.

CREATE TABLE IF NOT EXISTS public.timeclock_correction_requests (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_id               UUID NOT NULL,            -- de quién es el fichaje
  requested_by_employee_id  UUID,                     -- quién pidió
  target_event_id           UUID,                     -- editar uno existente; null = agregar
  proposed_type             TEXT NOT NULL
    CHECK (proposed_type IN ('in', 'out', 'break_start', 'break_end')),
  proposed_occurred_at      TIMESTAMPTZ NOT NULL,
  shift_assignment_id       UUID,
  reason                    TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected')),
  resolved_by               UUID,
  resolved_at               TIMESTAMPTZ,
  resolve_note              TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timeclock_correction_requests_company_status_idx
  ON public.timeclock_correction_requests(company_id, status, created_at DESC);

COMMENT ON TABLE public.timeclock_correction_requests IS
  'Solicitudes de corrección de fichajes (agregar/editar). Aplicadas por quien tiene timeclock:correct.';

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.timeclock_correction_requests ENABLE ROW LEVEL SECURITY;

-- Empleado: crear + leer sus propias solicitudes.
CREATE POLICY tcr_own_rw ON public.timeclock_correction_requests
  FOR ALL TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );

-- Manager/owner: leer + resolver las del tenant.
CREATE POLICY tcr_tenant_manage ON public.timeclock_correction_requests
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.employees
      WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM public.employees
      WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

CREATE POLICY tcr_platform_admin ON public.timeclock_correction_requests
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());
