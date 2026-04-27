-- =============================================================================
-- MIGRATION: 20260427000003_whatsapp_pending_clarifications.sql
-- =============================================================================
-- Soporta el suggestion-loop por WhatsApp (commit 9). Cuando el manager
-- escribe por WhatsApp un texto de policy/rule que requiere clarificación
-- (ningún interpreter matchea / intent=complex), el bot guarda las
-- sugerencias generadas por el LLM y le contesta una lista numerada.
-- Cuando el manager responde "1" / "2" / "3" / texto libre, el sistema
-- resuelve la pending entry y procede.
--
-- Permisos: por default solo los empleados con role='manager' pueden
-- crear policies vía WhatsApp. Cada tenant puede ampliar/cambiar la
-- lista de roles permitidos modificando companies.whatsapp_policy_creator_roles.
-- =============================================================================

-- 1. Permiso configurable a nivel tenant.
ALTER TABLE companies
  ADD COLUMN whatsapp_policy_creator_roles TEXT[] NOT NULL DEFAULT ARRAY['manager'];

COMMENT ON COLUMN companies.whatsapp_policy_creator_roles IS
  'Lista de roles que pueden crear policies/rules vía WhatsApp. Default: solo manager. Ampliar editando este array (ej. ARRAY[''manager'', ''shift-leader'']).';

-- 2. Pending clarifications.
CREATE TABLE whatsapp_pending_clarifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Qué se iba a crear: 'policy' o 'rule'.
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('policy', 'rule')),
  -- Texto original que el manager mandó.
  original_text   TEXT NOT NULL,
  -- Sugerencias serializadas (array de objetos { id, suggestedText, ...meta }).
  suggestions     JSONB NOT NULL,
  -- Cuándo expira esta pending entry (típicamente NOW() + 10 min).
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = pending; NOT NULL = ya respondida o expirada.
  resolved_at     TIMESTAMPTZ
);

COMMENT ON TABLE whatsapp_pending_clarifications IS
  'Estado de suggestion-loop por WhatsApp: cada fila es una conversación pendiente entre el bot y el manager.';

-- Lookup por empleado pending (no resuelta). Filtramos resolved_at IS NULL
-- para que el lookup de "cuál es la pending entry de este empleado" sea
-- O(1). El filtro de expires_at se aplica en query time porque NOW() no
-- es indexable (volatile).
CREATE INDEX whatsapp_pending_clarifications_employee_idx
  ON whatsapp_pending_clarifications(employee_id, created_at DESC)
  WHERE resolved_at IS NULL;
