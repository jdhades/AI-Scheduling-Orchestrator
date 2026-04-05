-- =============================================================================
-- MIGRATION: 20260407000000_scenario4_rule_strict_scoping.sql
-- =============================================================================

-- 1. Añadimos FKs nulos de scoping
ALTER TABLE semantic_rules ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;
ALTER TABLE semantic_rules ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE CASCADE;

-- 2. Actualizamos la función RPC vinculada a RAG
DROP FUNCTION IF EXISTS find_relevant_rules(vector, uuid, integer);

CREATE OR REPLACE FUNCTION find_relevant_rules(
    query_vector        VECTOR(768),
    company_id_param    UUID,
    top_k               INTEGER DEFAULT 10,
    branch_id_param     UUID DEFAULT NULL,
    department_id_param UUID DEFAULT NULL
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
    branch_id       UUID,
    department_id   UUID,
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
        sr.branch_id,
        sr.department_id,
        (sr.embedding <=> query_vector)::FLOAT AS distance
    FROM semantic_rules sr
    WHERE sr.company_id = company_id_param
      AND sr.is_active = TRUE
      AND sr.embedding IS NOT NULL
      AND (sr.expires_at IS NULL OR sr.expires_at > NOW())
      AND (sr.branch_id IS NULL OR branch_id_param IS NULL OR sr.branch_id = branch_id_param)
      AND (sr.department_id IS NULL OR department_id_param IS NULL OR sr.department_id = department_id_param)
    ORDER BY sr.embedding <=> query_vector
    LIMIT top_k;
END;
$$;
