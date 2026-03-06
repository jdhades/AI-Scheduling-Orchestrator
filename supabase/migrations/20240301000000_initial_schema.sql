-- =============================================================================
-- MIGRATION: 20240301000000_initial_schema.sql
-- AI Scheduling Orchestrator — Initial Schema + RLS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";           -- pgvector for RAG (Fase 3)

-- ---------------------------------------------------------------------------
-- TABLE: companies
-- Root tenant entity. All other tables reference this.
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL,
    allow_employee_swap BOOLEAN NOT NULL DEFAULT false,
    auto_notification   BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- TABLE: employees
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    phone_number        TEXT NOT NULL,
    whatsapp_verified   BOOLEAN NOT NULL DEFAULT false,
    hire_date           DATE NOT NULL,
    experience_months   INTEGER NOT NULL DEFAULT 0 CHECK (experience_months >= 0),
    role                TEXT NOT NULL DEFAULT 'employee',
    status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX employees_phone_company_idx ON employees(company_id, phone_number);

-- ---------------------------------------------------------------------------
-- TABLE: whatsapp_handshakes
-- Stores temporal verification tokens for WhatsApp binding (Phase 4)
-- ---------------------------------------------------------------------------
CREATE TABLE whatsapp_handshakes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    token           UUID NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    verified        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX handshakes_token_idx ON whatsapp_handshakes(token);

-- ---------------------------------------------------------------------------
-- TABLE: skills
-- Global skill catalog (shared across companies)
-- ---------------------------------------------------------------------------
CREATE TABLE skills (
    id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name    TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------------
-- TABLE: company_skills
-- Skills available within a specific company (tenant-scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE company_skills (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    UNIQUE (company_id, skill_id)
);

-- ---------------------------------------------------------------------------
-- TABLE: employee_skills
-- Skills assigned to a specific employee
-- ---------------------------------------------------------------------------
CREATE TABLE employee_skills (
    employee_id             UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_skill_id        UUID NOT NULL REFERENCES company_skills(id) ON DELETE CASCADE,
    level                   TEXT NOT NULL DEFAULT 'beginner'
                                CHECK (level IN ('beginner', 'intermediate', 'expert')),
    certification_expiration DATE,
    PRIMARY KEY (employee_id, company_skill_id)
);

-- ---------------------------------------------------------------------------
-- TABLE: shifts
-- ---------------------------------------------------------------------------
CREATE TABLE shifts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    start_time        TIMESTAMPTZ NOT NULL,
    end_time          TIMESTAMPTZ NOT NULL,
    required_skill_id UUID REFERENCES company_skills(id),
    demand_score      NUMERIC(5,2) NOT NULL DEFAULT 1.0,
    undesirable_weight NUMERIC(5,2) NOT NULL DEFAULT 0.0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_time > start_time)
);

-- ---------------------------------------------------------------------------
-- TABLE: shift_assignments
-- ---------------------------------------------------------------------------
CREATE TABLE shift_assignments (
    shift_id           UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    employee_id        UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    fairness_snapshot  JSONB,
    assigned_by_ai     BOOLEAN NOT NULL DEFAULT false,
    assigned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shift_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- TABLE: fairness_history
-- Weekly fairness tracking per employee
-- ---------------------------------------------------------------------------
CREATE TABLE fairness_history (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id       UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    week_start        DATE NOT NULL,
    score             NUMERIC(5,2) NOT NULL DEFAULT 0.0,
    undesirable_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (employee_id, week_start)
);

-- ---------------------------------------------------------------------------
-- TABLE: semantic_rules  (RAG — Fase 3)
-- Company-specific business rules stored as text + vector embedding
-- ---------------------------------------------------------------------------
CREATE TABLE semantic_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rule_text       TEXT NOT NULL,
    embedding       VECTOR(1536),               -- dimension for text-embedding-3-small
    priority_level  INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX semantic_rules_embedding_idx
    ON semantic_rules USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- ---------------------------------------------------------------------------
-- TABLE: incidents
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('medical', 'personal', 'no-show')),
    start_date      DATE NOT NULL,
    end_date        DATE,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
    ocr_confidence  NUMERIC(4,3),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- All tables scoped to company_id.
-- app.tenant_id is set by the backend before each query.
-- =============================================================================

ALTER TABLE employees           ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_handshakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_skills      ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_skills     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fairness_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents           ENABLE ROW LEVEL SECURITY;
-- companies & skills: no RLS (global catalog, read-only for tenants)

-- Helper function: extracts current tenant from PostgreSQL session variable
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
    SELECT current_setting('app.tenant_id', true)::UUID;
$$ LANGUAGE SQL STABLE;

-- Policy template: tenant can only see their own rows
CREATE POLICY tenant_isolation ON employees
    USING (company_id = current_tenant_id());

CREATE POLICY tenant_isolation ON whatsapp_handshakes
    USING (
        employee_id IN (
            SELECT id FROM employees WHERE company_id = current_tenant_id()
        )
    );

CREATE POLICY tenant_isolation ON company_skills
    USING (company_id = current_tenant_id());

CREATE POLICY tenant_isolation ON employee_skills
    USING (
        employee_id IN (
            SELECT id FROM employees WHERE company_id = current_tenant_id()
        )
    );

CREATE POLICY tenant_isolation ON shifts
    USING (company_id = current_tenant_id());

CREATE POLICY tenant_isolation ON shift_assignments
    USING (
        shift_id IN (
            SELECT id FROM shifts WHERE company_id = current_tenant_id()
        )
    );

CREATE POLICY tenant_isolation ON fairness_history
    USING (company_id = current_tenant_id());

CREATE POLICY tenant_isolation ON semantic_rules
    USING (company_id = current_tenant_id());

CREATE POLICY tenant_isolation ON incidents
    USING (company_id = current_tenant_id());
