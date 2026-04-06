-- =============================================================================
-- MIGRATION: 20260406000000_scenario4_rule_filters.sql
-- (Named using 2026 to ensure it runs after 20260328000000_v2_enterprise_schema.sql)
--
-- AI Scheduling Orchestrator — Escenario 4: Conversational Rule Expiration
-- =============================================================================

-- 1. Añadimos la columna de caducidad
ALTER TABLE semantic_rules ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 2. Actualizamos la función RPC vinculada a RAG para que filtre caducidad invisiblemente
DROP FUNCTION IF EXISTS find_relevant_rules(vector, uuid, integer);

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
    expires_at      TIMESTAMPTZ,
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
        sr.expires_at,
        (sr.embedding <=> query_vector)::FLOAT AS distance
    FROM semantic_rules sr
    WHERE sr.company_id = company_id_param
      AND sr.is_active = TRUE
      AND sr.embedding IS NOT NULL
      AND (sr.expires_at IS NULL OR sr.expires_at > NOW())
    ORDER BY sr.embedding <=> query_vector
    LIMIT top_k;
END;
$$;
