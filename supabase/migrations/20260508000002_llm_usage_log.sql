-- =============================================================================
-- LLM usage log — granular por llamada (Phase F.6 — token spend dashboard)
-- =============================================================================
-- Cada llamada al LLM (Qwen, Gemini, LocalLLM) escribe una fila acá.
-- Permite dashboards de costo por subsistema:
--   • schedule_generation → costo por horario generado
--   • whatsapp_classify   → costo por mensaje WhatsApp interpretado
--   • rule_rephrase       → costo del suggestion-loop de reglas
--   • policy_match        → costo del catch-all llm_runtime interpreter
--
-- `company_id` nullable porque algunos contextos no lo tienen aún
-- (futuro multi-tenant fully wired). El timestamp tiene índice para
-- queries de rangos del dashboard ("últimos 7 días").
-- =============================================================================

CREATE TABLE IF NOT EXISTS llm_usage_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NULL,
  -- Subsistema que disparó la call. Texto libre (no enum) para no
  -- requerir migration al sumar nuevos consumers.
  operation           TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_tokens       INT  NOT NULL DEFAULT 0,
  completion_tokens   INT  NOT NULL DEFAULT 0,
  total_tokens        INT  NOT NULL DEFAULT 0,
  -- Duración de la llamada al provider (no del job entero).
  duration_ms         INT  NULL,
  -- Si la llamada vino de un schedule.generate, link al job_id para
  -- poder agregar tokens del job. NULL para WhatsApp/rules/etc.
  job_id              UUID NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index para "últimas N llamadas del tenant" o "rango de tiempo".
CREATE INDEX IF NOT EXISTS llm_usage_log_company_time_idx
  ON llm_usage_log (company_id, created_at DESC);

-- Index para totales por operation en un rango de tiempo (group by op).
CREATE INDEX IF NOT EXISTS llm_usage_log_operation_time_idx
  ON llm_usage_log (operation, created_at DESC);
