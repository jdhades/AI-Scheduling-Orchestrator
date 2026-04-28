-- =============================================================================
-- MIGRATION: 20260427000000_company_policies.sql
-- =============================================================================
-- Subsystem nuevo: CompanyPolicy. Reemplaza invariantes hardcodeados del
-- scheduler (ej. "11h descanso entre turnos") y permite que cada tenant
-- configure reglas tenant-wide que el matcher schema de SemanticRule no
-- puede expresar (counting/distribution: "2 días de descanso por semana").
--
-- Diseño abierto: policy = texto NL + params + interpreter_id opcional.
-- Si el registry tiene un PolicyInterpreter en código que matchea, se
-- enchufa al solver deterministic (rápido). Si no, la policy queda
-- LLM-only y se pasa al prompt de schedule generation. Sin enum cerrado
-- de policy_type → multi-tenant friendly.
-- =============================================================================

CREATE TABLE company_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  text            TEXT NOT NULL CHECK (length(text) >= 10),
  severity        TEXT NOT NULL CHECK (severity IN ('hard', 'soft')),
  params          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- interpreter_id es free-form; puede ser NULL si ningún interpreter
  -- en código matchea el texto. En ese caso la policy se pasa al LLM
  -- en el prompt de schedule generation.
  interpreter_id  TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

COMMENT ON TABLE company_policies IS
  'Políticas tenant-wide del scheduler. Texto NL + params + interpreter_id opcional. Reemplaza invariantes hardcodeados.';
COMMENT ON COLUMN company_policies.interpreter_id IS
  'Identificador del PolicyInterpreter en código (ej. "min_rest_days_per_week"). NULL si la policy es LLM-only.';
COMMENT ON COLUMN company_policies.severity IS
  '"hard" = constraint inviolable; "soft" = preferencia que el solver intenta respetar.';
COMMENT ON COLUMN company_policies.params IS
  'Params estructurados extraídos por el interpreter. Vacío {} para policies sin interpreter.';

-- Índices base
CREATE INDEX company_policies_company_idx
  ON company_policies(company_id);

CREATE INDEX company_policies_active_idx
  ON company_policies(company_id, is_active)
  WHERE deleted_at IS NULL;

-- Una policy activa por (tenant, interpreter): si dos policies activas
-- referencian al mismo interpreter el solver no sabría a cuál hacer caso.
-- Para policies sin interpreter (interpreter_id IS NULL) no aplica el
-- constraint — puede haber múltiples LLM-only policies por tenant.
CREATE UNIQUE INDEX company_policies_unique_active_per_interpreter
  ON company_policies(company_id, interpreter_id)
  WHERE deleted_at IS NULL AND interpreter_id IS NOT NULL;

-- =============================================================================
-- SEED: la regla del usuario "2 días de descanso aparte del feriado"
-- Era una semantic_rule pero el matcher schema no soporta counting/
-- distribution; ahora vive como CompanyPolicy con el interpreter
-- min_rest_days_per_week. Se inserta una por cada tenant existente.
--
-- Nota: el cleanup del row equivalente en semantic_rules vive en commit 7
-- (migration de datos para soft-deletear la rule original). Acá solo
-- creamos la policy nueva.
-- =============================================================================

INSERT INTO company_policies (
  company_id, text, severity, params, interpreter_id, is_active, created_by
)
SELECT
  c.id,
  '2 días de descanso para el empleado aparte del feriado',
  'hard',
  jsonb_build_object('days', 2, 'holidayCounts', false),
  'min_rest_days_per_week',
  true,
  'system:seed_20260427'
FROM companies c
WHERE NOT EXISTS (
  -- Idempotente: si ya existe una policy activa para este interpreter
  -- (ej. la migración corre dos veces o hay un seed previo), no re-insertar.
  SELECT 1 FROM company_policies cp
  WHERE cp.company_id = c.id
    AND cp.interpreter_id = 'min_rest_days_per_week'
    AND cp.deleted_at IS NULL
);
