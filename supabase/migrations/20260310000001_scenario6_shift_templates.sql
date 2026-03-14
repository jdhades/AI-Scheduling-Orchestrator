-- =============================================================================
-- MIGRATION: 20260310000001_scenario6_shift_templates.sql
-- Phase 2: Shift Templates Engine
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TABLE: shift_templates
-- Reusable recurring shift definitions. A template says "every Tuesday,
-- there's a Morning Cook shift from 08:00 to 16:00."
-- ---------------------------------------------------------------------------
CREATE TABLE shift_templates (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,                          -- e.g. "Apertura Cocina"
    day_of_week          INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0=Sun
    start_time           TIME NOT NULL,                          -- e.g. 08:00
    end_time             TIME NOT NULL,                          -- e.g. 16:00
    required_skill_id    UUID REFERENCES company_skills(id),     -- nullable = no skill required
    demand_score         NUMERIC(5,2) NOT NULL DEFAULT 1.0,
    undesirable_weight   NUMERIC(5,2) NOT NULL DEFAULT 0.0,
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_time > start_time)
);

-- ---------------------------------------------------------------------------
-- Link concrete shift instances back to the template that generated them
-- ---------------------------------------------------------------------------
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES shift_templates(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
ALTER TABLE shift_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON shift_templates
    USING (company_id = current_tenant_id());

-- Index for fast template lookups per company
CREATE INDEX shift_templates_company_idx ON shift_templates(company_id, is_active);
