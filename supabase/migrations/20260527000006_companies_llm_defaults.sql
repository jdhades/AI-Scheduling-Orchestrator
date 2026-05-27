-- MIGRATION: companies.llm_provider / llm_model defaults.
--
-- Sprint llm-enforcement (2026-05-27). Hasta ahora la columna era nullable
-- y NULL significaba "fallback al env-wide". Eso tiene 2 problemas:
--
--   1. El budget enforcement chequea por `(companyId, model)`. Si el
--      tenant tiene llm_model=NULL, modelLabel cae a provider=NULL y
--      el chequeo nunca matchea — efectivamente budget bypass.
--   2. Cuando admin cambia el env-wide (ej. de qwen3.6-plus a
--      qwen3.7-max), todos los tenants nuevos cambian de modelo sin
--      avisar. Para soporte es invisible quién consumió qué modelo
--      cuando.
--
-- Fix: defaults explícitos en companies.llm_provider y llm_model.
-- Cualquier tenant nuevo arranca con `qwen` + `qwen3.6-plus` (los
-- valores reales que el sistema viene usando). Admin puede cambiarlos
-- per-tenant desde /admin/companies → LLM config.
--
-- Backfill: tenants existentes con NULL → setearles también el default
-- para que el budget enforcement matchee. Si soporte quería un tenant
-- en otro modelo, este script no lo toca (el override sigue valiendo).

-- Columna provider: setear default + backfill.
ALTER TABLE public.companies
  ALTER COLUMN llm_provider SET DEFAULT 'qwen';

UPDATE public.companies
  SET llm_provider = 'qwen'
  WHERE llm_provider IS NULL;

-- Columna model: setear default + backfill.
ALTER TABLE public.companies
  ALTER COLUMN llm_model SET DEFAULT 'qwen3.6-plus';

UPDATE public.companies
  SET llm_model = 'qwen3.6-plus'
  WHERE llm_model IS NULL;

COMMENT ON COLUMN public.companies.llm_provider IS
  'LLM provider del tenant. Default qwen. Valores: qwen | gemini | local. Admin puede override desde /admin/companies.';

COMMENT ON COLUMN public.companies.llm_model IS
  'Modelo específico del provider. Default qwen3.6-plus (matchea el provider qwen default). Admin puede override.';
