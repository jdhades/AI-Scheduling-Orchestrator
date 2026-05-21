-- MIGRATION: llm_prompt_history — registro completo de prompts + respuestas
-- de cada llamada LLM. Permite a soporte/dev:
--   - Debug: "qué le dijo el AI en este run que salió mal"
--   - Auditoría de privacidad: revisar qué PII se manda al LLM
--   - Mejora iterativa de prompts (comparar éxitos vs fallos)
--   - Análisis de tamaño/costo (prompt bloat)
--
-- Separada de `llm_usage_log` porque los prompts son pesados (10-50KB
-- típicamente para schedule generation) y degradarían las queries de
-- aggregation de tokens. JOIN por (company_id, created_at) si se
-- necesita correlacionar.
--
-- TTL: sin cron automático en v1. Cuando la tabla crezca lo suficiente,
-- agregamos un cron que borra >90 días (manteniendo agregados aparte).

CREATE TABLE IF NOT EXISTS public.llm_prompt_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NULL,
  -- Subsistema que disparó la call. Texto libre alineado con
  -- llm_usage_log.operation para correlacionar:
  --   schedule_generation | rule_translation | rule_rephrase |
  --   rule_structure_extract | policy_match | policy_runtime |
  --   whatsapp_classify | whatsapp_classify_audio | etc.
  operation       TEXT NOT NULL,
  -- Texto completo enviado al LLM. TEXT (no JSONB) porque no
  -- queremos indexarlo, solo persistir y mostrar.
  prompt_text     TEXT NOT NULL,
  -- Respuesta cruda del LLM (pre-parsing). Null si falló antes de
  -- recibir respuesta.
  response_text   TEXT NULL,
  -- Provider + modelo usados en este run. Útil para diferenciar entre
  -- runs del mismo tenant cuando admin cambia su LLM config.
  model_used      TEXT NULL,
  -- Tokens totales (incluye prompt + completion). Coincide con
  -- llm_usage_log.total_tokens cuando hay match.
  tokens_used     INT NULL,
  duration_ms     INT NULL,
  success         BOOLEAN NOT NULL DEFAULT true,
  error_message   TEXT NULL,
  -- Cuando aplica, link al run de schedule generation (mismo job_id).
  -- NULL para WhatsApp / rules / policies que no tienen job.
  job_id          UUID NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index para "últimos prompts del tenant" (admin viewer).
CREATE INDEX IF NOT EXISTS llm_prompt_history_company_time_idx
  ON public.llm_prompt_history (company_id, created_at DESC);

-- Index para filtrar por operation.
CREATE INDEX IF NOT EXISTS llm_prompt_history_operation_time_idx
  ON public.llm_prompt_history (operation, created_at DESC);

-- Index para correlacionar con un job específico.
CREATE INDEX IF NOT EXISTS llm_prompt_history_job_idx
  ON public.llm_prompt_history (job_id)
  WHERE job_id IS NOT NULL;

-- RLS: lockdown total (solo platform admin via service_role).
ALTER TABLE public.llm_prompt_history ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.llm_prompt_history IS
  'Registro completo de prompts + respuestas LLM. Solo lectura desde admin/soporte. Separado de llm_usage_log por peso de payloads.';
