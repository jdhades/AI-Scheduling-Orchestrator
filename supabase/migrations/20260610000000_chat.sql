-- MIGRATION: tenant business chat (Sprint 3, Phase 1)
--
-- WhatsApp-style chat inside the tenant: 1:1 (dm) and group rooms. Accessed via
-- the backend REST + Socket.IO gateway (service-role bypasses RLS and enforces
-- per-room membership in code). RLS here is defense-in-depth: tenant isolation
-- (a row is only visible to members of its company).

-- ─── chat_rooms ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_rooms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('dm', 'group')),
  -- Group name. NULL for dm (the UI derives the name from the other member).
  name        TEXT NULL,
  created_by  UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_rooms_company_idx ON public.chat_rooms(company_id);

-- ─── chat_room_members ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_room_members (
  room_id      UUID NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  employee_id  UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  company_id   UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  -- Last time this member read the room → drives the unread badge.
  last_read_at TIMESTAMPTZ NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, employee_id)
);
CREATE INDEX IF NOT EXISTS chat_room_members_employee_idx
  ON public.chat_room_members(employee_id);
CREATE INDEX IF NOT EXISTS chat_room_members_company_idx
  ON public.chat_room_members(company_id);

-- ─── chat_messages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  room_id     UUID NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  sender_id   UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  content     TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  -- Client-generated idempotency key (offline-safe send retries).
  client_uuid UUID NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_client_uuid_unique UNIQUE (room_id, client_uuid)
);
CREATE INDEX IF NOT EXISTS chat_messages_room_idx
  ON public.chat_messages(room_id, created_at DESC);

COMMENT ON TABLE public.chat_messages IS
  'Tenant chat messages. Idempotent send by (room_id, client_uuid).';

-- ─── RLS (defense-in-depth — tenant isolation) ──────────────────────────
ALTER TABLE public.chat_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- A row is visible to authenticated members of its company. Per-room membership
-- is enforced by the backend (the only access path).
CREATE POLICY chat_rooms_tenant_read ON public.chat_rooms
  FOR SELECT TO authenticated
  USING (
    company_id IN (SELECT company_id FROM public.employees WHERE auth_user_id = auth.uid())
  );
CREATE POLICY chat_rooms_platform_admin ON public.chat_rooms
  FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE POLICY chat_room_members_tenant_read ON public.chat_room_members
  FOR SELECT TO authenticated
  USING (
    company_id IN (SELECT company_id FROM public.employees WHERE auth_user_id = auth.uid())
  );
CREATE POLICY chat_room_members_platform_admin ON public.chat_room_members
  FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE POLICY chat_messages_tenant_read ON public.chat_messages
  FOR SELECT TO authenticated
  USING (
    company_id IN (SELECT company_id FROM public.employees WHERE auth_user_id = auth.uid())
  );
CREATE POLICY chat_messages_platform_admin ON public.chat_messages
  FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
