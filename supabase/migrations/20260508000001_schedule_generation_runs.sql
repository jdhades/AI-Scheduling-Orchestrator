-- =============================================================================
-- Histórico de generaciones de horario (Phase F.6 — dashboard insights)
-- =============================================================================
-- Cada disparo de `schedule.generate` que termina (completed / failed /
-- cancelled) escribe una fila acá. Permite al manager:
--   • Ver últimas N generaciones con duración + costo LLM (tokens, calls)
--   • Auditar fallos
--   • Mostrar explanation + warnings del último run en el dashboard
--
-- NO reemplaza pg-boss (que sigue siendo la cola); este es un proyección
-- domain-friendly con índices propios. pg-boss limpia jobs viejos según
-- retention policy; nosotros queremos historial perpetuo.
--
-- llm_* nullables: el path determinístico (SKIP_LLM_PROPOSER=true,
-- legacy) no toca LLM. Cancel pre-pickup tampoco gasta tokens.
-- =============================================================================

CREATE TABLE IF NOT EXISTS schedule_generation_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID NOT NULL,
  week_start               DATE NOT NULL,
  -- pg-boss job id. Sin FK porque pg-boss puede borrar el job antes
  -- (retention) y queremos preservar la historia.
  job_id                   UUID NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  source                   TEXT NOT NULL CHECK (source IN ('http', 'whatsapp')),
  assignments_count        INT NULL,
  unfilled_count           INT NULL,
  llm_calls                INT NULL,
  llm_prompt_tokens        INT NULL,
  llm_completion_tokens    INT NULL,
  llm_total_tokens         INT NULL,
  duration_ms              INT NOT NULL,
  -- Texto del LLM (si lo hubo) — explanation + warnings.
  -- TEXT en vez de JSONB porque se renderea tal cual; sin queries
  -- internas que justifiquen estructura.
  explanation              TEXT NULL,
  warnings                 TEXT[] NULL,
  error_message            TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index para "últimas N generaciones del tenant" (dashboard widget).
CREATE INDEX IF NOT EXISTS schedule_generation_runs_company_time_idx
  ON schedule_generation_runs (company_id, created_at DESC);

-- Index para "historial de una semana puntual".
CREATE INDEX IF NOT EXISTS schedule_generation_runs_company_week_idx
  ON schedule_generation_runs (company_id, week_start, created_at DESC);
