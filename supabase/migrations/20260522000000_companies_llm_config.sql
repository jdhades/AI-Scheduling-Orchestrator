-- MIGRATION: companies.llm_provider + llm_model — habilita que el admin
-- de soporte asigne qué LLM usa cada tenant. Null = fallback al env-wide
-- (`AI_ACTIVE_PROVIDER`); cuando el admin setea un valor, ese tenant
-- empieza a usarlo para schedule generation (otros consumers siguen con
-- env-wide hasta una pasada siguiente).

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS llm_provider TEXT NULL
    CHECK (llm_provider IS NULL OR llm_provider IN ('qwen', 'gemini', 'local')),
  ADD COLUMN IF NOT EXISTS llm_model TEXT NULL;

COMMENT ON COLUMN public.companies.llm_provider IS
  'LLM provider asignado por admin de soporte. NULL = fallback al env-wide. Valores: qwen | gemini | local.';

COMMENT ON COLUMN public.companies.llm_model IS
  'Modelo específico del provider (ej. qwen3.6-plus, gemini-2.0-flash). NULL = default del provider.';
