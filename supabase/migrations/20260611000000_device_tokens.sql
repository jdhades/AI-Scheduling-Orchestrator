-- MIGRATION: device push tokens (Sprint 4 — push notifications)
--
-- One row per device/app install. The mobile app registers its Expo push token
-- on login; the backend sends to the Expo Push API. Unique by token (a token
-- moving to another account re-points via upsert).

CREATE TABLE IF NOT EXISTS public.device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_id  UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_tokens_employee_idx
  ON public.device_tokens(company_id, employee_id);

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY device_tokens_own_rw ON public.device_tokens
  FOR ALL TO authenticated
  USING (employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid()))
  WITH CHECK (employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid()));

CREATE POLICY device_tokens_platform_admin ON public.device_tokens
  FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
