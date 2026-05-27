-- MIGRATION: imports_staging — sistema de importación multi-modal (Fase 1).
--
-- Spine para que owners traigan empleados, turnos, disponibilidad, breaks
-- y time-off vía 3 vías paralelas (upload libre con AI, plantillas Excel,
-- prompt portable para agente externo). Las 3 vías convergen al mismo
-- payload canónico que se stagea acá → owner revisa preview → confirma.
--
-- Esta migration NO cubre los entrypoints de las 3 vías — solo el spine
-- común: tabla de staging, capability nueva, threshold de confidence.

-- ─── 1. companies.imports_confidence_threshold ─────────────────────────
-- Soporte / admin de tenant puede ajustarlo. Default 0.85 — entidades
-- por encima son verde-auto, las de 0.6..0.84 amarillo (revisión sugerida),
-- y <0.6 rojo (revisión obligatoria). Per-tenant porque equipos con datos
-- históricos limpios pueden bajarlo a 0.7, y operaciones más críticas
-- (compliance) subirlo a 0.95.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS imports_confidence_threshold NUMERIC(3, 2)
    NOT NULL DEFAULT 0.85
    CHECK (imports_confidence_threshold BETWEEN 0 AND 1);

COMMENT ON COLUMN public.companies.imports_confidence_threshold IS
  'Umbral mínimo de confidence para auto-aceptar filas en el preview de imports. 0..1, default 0.85.';

-- ─── 2. imports_staging ────────────────────────────────────────────────
-- TTL 5 días — el owner tiene ventana para revisar sin presión, pero no
-- queremos acumular indefinidamente. Cleanup vía pg-boss daily.
CREATE TABLE IF NOT EXISTS public.imports_staging (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  source          TEXT NOT NULL CHECK (source IN (
                    'upload_freeform',
                    'template_excel',
                    'external_agent'
                  )),
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
                    'pending_review',
                    'confirming',
                    'committed',
                    'failed',
                    'discarded'
                  )) DEFAULT 'pending_review',
  preview_cache   JSONB,
  commit_report   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '5 days'),
  committed_at    TIMESTAMPTZ
);

-- Listado típico: "mis imports pendientes"
CREATE INDEX IF NOT EXISTS imports_staging_company_status_idx
  ON public.imports_staging (company_id, status, created_at DESC);

-- Cleanup job: pendientes vencidos
CREATE INDEX IF NOT EXISTS imports_staging_expires_idx
  ON public.imports_staging (expires_at)
  WHERE status = 'pending_review';

-- ─── 3. RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.imports_staging ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.imports_staging
  FOR ALL TO authenticated
  USING (company_id = public.user_company_id())
  WITH CHECK (company_id = public.user_company_id());

COMMENT ON TABLE public.imports_staging IS
  'Staging de imports multi-modal. Owner stagea payload canónico → revisa preview → confirma. TTL 5d. status=committed conserva el commit_report para auditoría.';

-- ─── 4. Capability imports:run ─────────────────────────────────────────
-- Default solo owner — importar masivamente datos es operación sensible.
-- El admin de tenant puede grantear via employee_capabilities a manager
-- puntual si lo necesita.
INSERT INTO public.company_role_capabilities (company_id, role, capability)
SELECT id, 'owner', 'imports:run' FROM public.companies
ON CONFLICT (company_id, role, capability) DO NOTHING;

-- ─── 5. Trigger update — companies nuevas también heredan ──────────────
-- Reemplazamos la función entera para que companies futuras incluyan
-- imports:run sin que tenga que correr otra migration.
CREATE OR REPLACE FUNCTION public.seed_default_role_capabilities()
RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.company_role_capabilities (company_id, role, capability)
  VALUES
    (NEW.id, 'owner', 'billing:manage'),
    (NEW.id, 'owner', 'settings:manage'),
    (NEW.id, 'owner', 'team:assign_scope'),
    (NEW.id, 'owner', 'team:grant_capability'),
    (NEW.id, 'owner', 'branches:write'),
    (NEW.id, 'owner', 'departments:write'),
    (NEW.id, 'owner', 'employees:write'),
    (NEW.id, 'owner', 'employees:wages_read'),
    (NEW.id, 'owner', 'policies:write'),
    (NEW.id, 'owner', 'policies:read'),
    (NEW.id, 'owner', 'schedule:generate'),
    (NEW.id, 'owner', 'schedule:write'),
    (NEW.id, 'owner', 'swaps:approve'),
    (NEW.id, 'owner', 'absences:approve'),
    (NEW.id, 'owner', 'incidents:manage'),
    (NEW.id, 'owner', 'dayoffs:approve'),
    (NEW.id, 'owner', 'audit:read'),
    (NEW.id, 'owner', 'imports:run'),
    (NEW.id, 'manager', 'departments:write'),
    (NEW.id, 'manager', 'employees:write'),
    (NEW.id, 'manager', 'policies:read'),
    (NEW.id, 'manager', 'schedule:generate'),
    (NEW.id, 'manager', 'schedule:write'),
    (NEW.id, 'manager', 'swaps:approve'),
    (NEW.id, 'manager', 'absences:approve'),
    (NEW.id, 'manager', 'incidents:manage'),
    (NEW.id, 'manager', 'dayoffs:approve'),
    (NEW.id, 'manager', 'audit:read'),
    (NEW.id, 'employee', 'audit:read'),
    (NEW.id, 'employee', 'policies:read')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
