-- MIGRATION: support_tickets — reportes de error que mandan los managers/owners
-- del tenant al equipo de plataforma. Aparecen en /admin/support-tickets.
--
-- Attachments (imagen/video) los registramos en una tabla separada
-- support_ticket_attachments; el subir efectivamente está GATED por la
-- feature flag 'support_ticket_attachments' que arranca en off hasta
-- que se configure el bucket de Supabase Storage.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Quién reportó. Nullable para tolerar borrado del employee sin
  -- perder el histórico del ticket.
  reporter_employee_id  UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  reporter_auth_user_id UUID NULL,
  reporter_email        TEXT NULL,

  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description     TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  severity        TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high')),
  area            TEXT NOT NULL DEFAULT 'other'
    CHECK (area IN ('schedule', 'rules', 'policies', 'whatsapp', 'billing', 'auth', 'other')),

  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  -- Resolution: nota del admin al cerrar. Visible al reporter si decidimos
  -- exponerlo desde el panel del tenant (no en este sprint).
  resolution      TEXT NULL,
  resolved_by_auth_user_id UUID NULL,
  resolved_at     TIMESTAMPTZ NULL,

  -- Snapshot mínimo del contexto del cliente para reproducir el bug.
  -- Texto libre, lo manda el frontend (URL, browser, version del front).
  client_context  JSONB NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_tickets_company_idx
  ON public.support_tickets(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx
  ON public.support_tickets(status, created_at DESC);

COMMENT ON TABLE public.support_tickets IS
  'Tickets enviados por managers/owners de tenants al equipo de plataforma. Visibles cross-tenant en /admin/support-tickets.';

-- ─── Attachments ───────────────────────────────────────────────────────
-- Fila por archivo (imagen/video) adjunto. La fila se crea ANTES de
-- subir el archivo: el frontend pide un signed upload URL para el
-- storage_path generado, sube, y marca uploaded_at. Los rows con
-- uploaded_at=NULL se consideran "pending" (el cron podría barrerlos
-- si quedan huérfanos; por ahora no hace falta).
--
-- En este sprint TODO el flow está apagado por feature flag
-- 'support_ticket_attachments'. El backend responde 503 si la flag
-- está off y el frontend hidea el input file.

CREATE TABLE IF NOT EXISTS public.support_ticket_attachments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  -- Path en el bucket de Supabase Storage. Convención: tickets/{ticket_id}/{uuid}.{ext}
  storage_path     TEXT NOT NULL,
  bucket           TEXT NOT NULL DEFAULT 'support-attachments',
  mime_type        TEXT NULL,
  size_bytes       BIGINT NULL,
  -- NULL = upload pending; set cuando el frontend confirma que subió ok.
  uploaded_at      TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_attachments_ticket_idx
  ON public.support_ticket_attachments(ticket_id);

COMMENT ON TABLE public.support_ticket_attachments IS
  'Adjuntos (imágenes/videos) por ticket. Storage en bucket support-attachments. Flow apagado por feature flag support_ticket_attachments.';

-- ─── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_attachments ENABLE ROW LEVEL SECURITY;

-- Tenant: manager/owner del tenant inserta y lee SUS tickets.
-- (Empleados no pueden — se valida también en el guard del controller.)
CREATE POLICY support_tickets_tenant_rw ON public.support_tickets
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

-- Platform admin: read+write cross-tenant.
CREATE POLICY support_tickets_platform_admin ON public.support_tickets
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

-- Attachments: mismo modelo via parent ticket.
CREATE POLICY support_ticket_attachments_tenant_rw
  ON public.support_ticket_attachments
  FOR ALL TO authenticated
  USING (
    ticket_id IN (
      SELECT id FROM public.support_tickets
      WHERE company_id IN (
        SELECT company_id FROM public.employees
        WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
      )
    )
  )
  WITH CHECK (
    ticket_id IN (
      SELECT id FROM public.support_tickets
      WHERE company_id IN (
        SELECT company_id FROM public.employees
        WHERE auth_user_id = auth.uid() AND role IN ('owner', 'manager')
      )
    )
  );

CREATE POLICY support_ticket_attachments_platform_admin
  ON public.support_ticket_attachments
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.support_tickets, public.support_ticket_attachments
  TO postgres;

-- ─── Seed: registrar la feature flag attachments en el catálogo ───────
-- El catálogo de features vive en código (FEATURE_CATALOG), pero el
-- override per-tenant arranca disabled. Acá NO inserto nada — el backend
-- ya devuelve enabled=false por default cuando no hay override en
-- tenant_features. Para activar globalmente, soporte tiene que insertar
-- override por tenant desde /admin/companies/.../features.
