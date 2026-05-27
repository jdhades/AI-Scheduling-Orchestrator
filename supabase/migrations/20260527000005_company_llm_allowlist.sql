-- MIGRATION: company_llm_allowlist — whitelist por tenant.
--
-- Objetivo: el admin puede restringir a un tenant a un subset de los
-- (provider, model) del catálogo `available_llm_models`. Sin restringir:
-- el tenant tiene libertad de usar cualquier modelo (default actual).
--
-- Semantica:
--   - Sin filas para companyId → ALL allowed (compat con tenants existentes).
--   - Con N filas → solo esos (provider, model) están permitidos.
--
-- Esto deja a `available_llm_models` siendo el catálogo cross-tenant
-- (poblar dropdowns) y suma una capa de enforcement per-tenant.

CREATE TABLE IF NOT EXISTS public.company_llm_allowlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider, model)
);

-- Lookup típico: "¿está (provider, model) permitido para esta company?"
-- también listado per-company.
CREATE INDEX IF NOT EXISTS company_llm_allowlist_company_idx
  ON public.company_llm_allowlist (company_id);

-- RLS — no exponemos esta tabla a tenants. Solo platform admins via
-- service_role la administran. Sin policy de SELECT, los roles
-- `authenticated` y `anon` quedan bloqueados por default.
ALTER TABLE public.company_llm_allowlist ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.company_llm_allowlist IS
  'Whitelist per-tenant de (provider, model) LLM. Sin filas = todos permitidos. Con filas = solo esos. Admin-only (service_role).';
