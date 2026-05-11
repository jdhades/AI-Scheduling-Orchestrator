-- =============================================================================
-- Budgets de tokens por modelo LLM (Phase F.6 — dashboard de costo)
-- =============================================================================
-- Cada empresa puede definir el "techo" mensual esperado de tokens por modelo.
-- El dashboard usa este valor para mostrar "consumido vs total" como gauge
-- radial. Sin entry para un modelo, el front cae a un default global (NULL
-- company_id) o a 1M como último recurso.
--
-- Composite unique (company_id, model) — NULL company_id se trata como
-- "default global" (comparte index porque NULL distinct=true en Postgres
-- por default; usamos COALESCE wrapper para que NULL sea igual a NULL en
-- el unique).
-- =============================================================================

CREATE TABLE IF NOT EXISTS llm_model_budgets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = budget global default (visible para cualquier company sin
  -- override propio). Cualquier UUID = override por company.
  company_id               UUID NULL,
  model                    TEXT NOT NULL,
  monthly_budget_tokens    BIGINT NOT NULL CHECK (monthly_budget_tokens > 0),
  notes                    TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique (company_id, model). En Postgres, NULL != NULL por default en
-- unique constraints; usamos índice expression con COALESCE para que NULL
-- sea tratado como un valor único.
CREATE UNIQUE INDEX IF NOT EXISTS llm_model_budgets_company_model_uidx
  ON llm_model_budgets (COALESCE(company_id::text, ''), model);

-- Seed inicial: defaults globales para los modelos conocidos del sistema.
-- ON CONFLICT no aplica al unique expression, así que usamos un upsert
-- via WHERE NOT EXISTS subquery (idempotente).
INSERT INTO llm_model_budgets (company_id, model, monthly_budget_tokens, notes)
SELECT NULL, 'qwen3.6-plus', 1000000, 'Default global — paid tier DashScope'
WHERE NOT EXISTS (
  SELECT 1 FROM llm_model_budgets
  WHERE company_id IS NULL AND model = 'qwen3.6-plus'
);

INSERT INTO llm_model_budgets (company_id, model, monthly_budget_tokens, notes)
SELECT NULL, 'qwen-plus', 500000, 'Default global — free tier (legacy)'
WHERE NOT EXISTS (
  SELECT 1 FROM llm_model_budgets
  WHERE company_id IS NULL AND model = 'qwen-plus'
);
