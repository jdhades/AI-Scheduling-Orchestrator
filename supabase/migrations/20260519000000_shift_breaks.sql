-- MIGRATION: breaks intra-shift (descansos dentro del turno).
--
-- Decisiones del sprint Add-a-break (2026-05-18):
--   - is_paid es false por default (unpaid = el empleado no cobra esos
--     minutos). Algunos países requieren tracking legal del distinción.
--   - Multi-break: N breaks por shift. Constraint de no-overlap se hace
--     a nivel de domain service (no DB) porque requiere querying.
--   - Templates pueden tener defaultBreaks opcionales (start_offset_minutes
--     desde el inicio del shift + duration_minutes). Al crear un assignment
--     desde el template, esos defaults se materializan a tiempos absolutos.
--
-- RLS: company_id denormalizado en shift_assignment_breaks para que el
-- tenant_isolation policy sea trivial (= public.user_company_id()). Para
-- shift_template_breaks, el company_id sale via el template padre.

-- ─── shift_template_breaks ────────────────────────────────────────────
-- Defaults para que un template predefina breaks. Tiempos relativos
-- (offset desde el inicio + duración en minutos) — el template no
-- conoce la fecha concreta.
CREATE TABLE IF NOT EXISTS public.shift_template_breaks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id           UUID NOT NULL REFERENCES public.shift_templates(id) ON DELETE CASCADE,
  company_id            UUID NOT NULL,
  -- Minutos desde actualStartTime del shift. Ej. 240 = break empieza
  -- a las 4 horas de iniciado el turno.
  start_offset_minutes  INTEGER NOT NULL CHECK (start_offset_minutes >= 0),
  duration_minutes      INTEGER NOT NULL CHECK (duration_minutes > 0),
  is_paid               BOOLEAN NOT NULL DEFAULT false,
  reason                TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_template_breaks_template_idx
  ON public.shift_template_breaks(template_id);

CREATE INDEX IF NOT EXISTS shift_template_breaks_company_idx
  ON public.shift_template_breaks(company_id);

ALTER TABLE public.shift_template_breaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.shift_template_breaks
  FOR ALL TO authenticated
  USING (company_id = public.user_company_id())
  WITH CHECK (company_id = public.user_company_id());

-- ─── shift_assignment_breaks ──────────────────────────────────────────
-- Breaks concretos materializados sobre un assignment puntual. Tiempos
-- absolutos UTC (alineados al wall-clock del shift).
CREATE TABLE IF NOT EXISTS public.shift_assignment_breaks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   UUID NOT NULL REFERENCES public.shift_assignments(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  is_paid         BOOLEAN NOT NULL DEFAULT false,
  reason          TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS shift_assignment_breaks_assignment_idx
  ON public.shift_assignment_breaks(assignment_id);

CREATE INDEX IF NOT EXISTS shift_assignment_breaks_company_idx
  ON public.shift_assignment_breaks(company_id);

ALTER TABLE public.shift_assignment_breaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.shift_assignment_breaks
  FOR ALL TO authenticated
  USING (company_id = public.user_company_id())
  WITH CHECK (company_id = public.user_company_id());

COMMENT ON TABLE public.shift_template_breaks IS
  'Defaults de breaks por template. Tiempos relativos (offset + duración). Se materializan a tiempos absolutos al crear un assignment.';

COMMENT ON TABLE public.shift_assignment_breaks IS
  'Breaks concretos sobre un assignment. Tiempos absolutos UTC. Constraint no-overlap se enforce-a en domain (requiere querying).';
