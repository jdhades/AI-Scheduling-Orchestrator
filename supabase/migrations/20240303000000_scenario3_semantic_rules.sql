-- =============================================================================
-- MIGRATION: 20240303000000_scenario3_semantic_rules.sql
-- AI Scheduling Orchestrator — Escenario 3: Semantic Rule Engine (RAG)
--
-- Activa la extensión pgvector, crea la tabla de reglas semánticas con
-- soporte para búsqueda por similitud de embeddings y RLS multi-tenant.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- EXTENSIÓN: pgvector
-- Habilita el tipo VECTOR y los operadores de similitud (<->, <=>, <#>)
-- Supabase la soporta nativamente — solo necesita activarse.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;


-- ---------------------------------------------------------------------------
-- TABLE: semantic_rules
--
-- Almacena reglas de negocio en lenguaje natural convertidas a embeddings.
-- El campo embedding usa VECTOR(768) — dimensión de text-embedding-004 de Gemini.
--
-- priority_level: 1=legal, 2=semantic, 3=preference
-- rule_type: 'restriction' | 'preference' | 'requirement'
-- is_active: permite desactivar reglas sin borrarlas (soft delete)
-- metadata: JSON para datos adicionales (ej. shift_type, day_of_week)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rule_text       TEXT NOT NULL CHECK (char_length(rule_text) >= 10 AND char_length(rule_text) <= 1000),
    embedding       VECTOR(768),
    priority_level  INTEGER NOT NULL DEFAULT 2
        CHECK (priority_level BETWEEN 1 AND 3),
    rule_type       TEXT NOT NULL DEFAULT 'restriction'
        CHECK (rule_type IN ('restriction', 'preference', 'requirement')),
    created_by      UUID REFERENCES employees(id) ON DELETE SET NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- ÍNDICES: semantic_rules
--
-- ivfflat (vector_cosine_ops): búsqueda aproximada por similitud coseno.
--   lists=100: trade-off recall/velocidad para colecciones hasta ~1M vectores.
--   Para < 10k reglas por empresa, el rendimiento es óptimo.
--
-- semantic_rules_company_active_idx: filtrado eficiente por empresa + is_active
--   en todas las queries de recuperación semántica.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS semantic_rules_embedding_idx
    ON semantic_rules
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS semantic_rules_company_active_idx
    ON semantic_rules(company_id, is_active);

CREATE INDEX IF NOT EXISTS semantic_rules_priority_idx
    ON semantic_rules(company_id, priority_level);


-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY: semantic_rules
--
-- Garantía de aislamiento entre tenants a nivel de base de datos.
-- Ninguna query puede acceder a reglas de otra empresa aunque no tenga
-- filtrado en la capa de aplicación.
-- ---------------------------------------------------------------------------
ALTER TABLE semantic_rules ENABLE ROW LEVEL SECURITY;

-- SELECT: cada empresa solo ve sus propias reglas
CREATE POLICY "semantic_rules_select_policy"
    ON semantic_rules
    FOR SELECT
    USING (
        company_id = current_setting('app.current_company_id', TRUE)::UUID
    );

-- INSERT: solo puede insertar reglas con su propio company_id
CREATE POLICY "semantic_rules_insert_policy"
    ON semantic_rules
    FOR INSERT
    WITH CHECK (
        company_id = current_setting('app.current_company_id', TRUE)::UUID
    );

-- UPDATE: solo puede actualizar sus propias reglas
CREATE POLICY "semantic_rules_update_policy"
    ON semantic_rules
    FOR UPDATE
    USING (
        company_id = current_setting('app.current_company_id', TRUE)::UUID
    );

-- DELETE: solo puede eliminar sus propias reglas
CREATE POLICY "semantic_rules_delete_policy"
    ON semantic_rules
    FOR DELETE
    USING (
        company_id = current_setting('app.current_company_id', TRUE)::UUID
    );


-- ---------------------------------------------------------------------------
-- TABLE: rule_conflicts
--
-- Registro de conflictos detectados entre reglas y sus resoluciones.
-- Permite auditoría y análisis de patrones de conflicto para el admin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rule_conflicts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rule_a_id       UUID NOT NULL REFERENCES semantic_rules(id) ON DELETE CASCADE,
    rule_b_id       UUID NOT NULL REFERENCES semantic_rules(id) ON DELETE CASCADE,
    resolution      TEXT NOT NULL
        CHECK (resolution IN ('rule_a_wins', 'rule_b_wins', 'manual_required', 'escalated')),
    reason          TEXT,
    context         TEXT,
    resolved_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS rule_conflicts_company_idx
    ON rule_conflicts(company_id, resolved_at DESC);

ALTER TABLE rule_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rule_conflicts_select_policy"
    ON rule_conflicts
    FOR SELECT
    USING (
        company_id = current_setting('app.current_company_id', TRUE)::UUID
    );

CREATE POLICY "rule_conflicts_insert_policy"
    ON rule_conflicts
    FOR INSERT
    WITH CHECK (
        company_id = current_setting('app.current_company_id', TRUE)::UUID
    );


-- ---------------------------------------------------------------------------
-- FUNCIÓN RPC: find_relevant_rules
--
-- Búsqueda vectorial por distancia coseno con filtro por empresa.
-- Se expone como RPC de Supabase para que el repositorio la llame
-- directamente, evitando la exposición del tipo VECTOR en REST API.
--
-- SECURITY DEFINER: ejecuta con privilegios del creador (superuser),
-- pero el parámetro company_id_param hace el aislamiento explícito.
--
-- Parámetros:
--   query_vector     — embedding del contexto del turno (768 dims)
--   company_id_param — UUID de la empresa (tenant isolation)
--   top_k            — número máximo de reglas a retornar (default 10)
--
-- Retorna:
--   id, company_id, rule_text, embedding, priority_level, rule_type,
--   is_active, metadata, created_at + distance (float, 0=idéntico, 2=opuesto)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_relevant_rules(
    query_vector        VECTOR(768),
    company_id_param    UUID,
    top_k               INTEGER DEFAULT 10
)
RETURNS TABLE (
    id              UUID,
    company_id      UUID,
    rule_text       TEXT,
    embedding       VECTOR(768),
    priority_level  INTEGER,
    rule_type       TEXT,
    is_active       BOOLEAN,
    metadata        JSONB,
    created_at      TIMESTAMPTZ,
    distance        FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        sr.id,
        sr.company_id,
        sr.rule_text,
        sr.embedding,
        sr.priority_level,
        sr.rule_type,
        sr.is_active,
        sr.metadata,
        sr.created_at,
        (sr.embedding <=> query_vector)::FLOAT AS distance
    FROM semantic_rules sr
    WHERE sr.company_id = company_id_param
      AND sr.is_active = TRUE
      AND sr.embedding IS NOT NULL
    ORDER BY sr.embedding <=> query_vector
    LIMIT top_k;
END;
$$;


-- ---------------------------------------------------------------------------
-- FUNCIÓN: update_updated_at_column
-- Auto-actualiza updated_at en cada UPDATE de semantic_rules
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_semantic_rules_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_rules_updated_at_trigger
    BEFORE UPDATE ON semantic_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_semantic_rules_updated_at();


-- ---------------------------------------------------------------------------
-- COMENTARIOS DE DOCUMENTACIÓN
-- ---------------------------------------------------------------------------
COMMENT ON TABLE semantic_rules IS
    'Reglas de negocio en lenguaje natural con embeddings para búsqueda semántica (RAG). Escenario 3.';

COMMENT ON COLUMN semantic_rules.embedding IS
    'Vector de 768 dimensiones generado por Gemini text-embedding-004. NULL hasta que se procese.';

COMMENT ON COLUMN semantic_rules.priority_level IS
    '1=legal (máxima precedencia), 2=semántica (por defecto), 3=preferencia (menor precedencia)';

COMMENT ON COLUMN semantic_rules.rule_type IS
    'restriction: bloquea asignación | preference: orienta sin bloquear | requirement: requiere cumplimiento';

COMMENT ON COLUMN semantic_rules.is_active IS
    'Soft delete: false = regla desactivada pero preservada para auditoría';

COMMENT ON COLUMN semantic_rules.metadata IS
    'Datos adicionales: { shift_type, day_of_week, employee_id, tags[] }';

COMMENT ON TABLE rule_conflicts IS
    'Registro de conflictos entre reglas semánticas y sus resoluciones. Para auditoría del ConflictResolutionEngine.';

COMMENT ON FUNCTION find_relevant_rules IS
    'RPC Supabase: búsqueda vectorial por cosine distance con tenant isolation explícito. Retorna top-K reglas más relevantes.';
