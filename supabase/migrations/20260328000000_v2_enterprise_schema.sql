-- =============================================================================
-- MIGRATION: 20260328000000_v2_enterprise_schema.sql
-- Phase 3: SaaS Enterprise Architecture (Branches, Departments, Patial Assignments)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TABLE: branches (Sucursales)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branches USING (company_id = current_tenant_id());
CREATE INDEX branches_company_idx ON branches(company_id);

-- ---------------------------------------------------------------------------
-- TABLE: departments (Departamentos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE, -- Denormalized for fast RLS
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON departments USING (company_id = current_tenant_id());
CREATE INDEX departments_branch_idx ON departments(branch_id);

-- ---------------------------------------------------------------------------
-- MODIFY: employees
-- ---------------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- MODIFY: shift_templates
-- ---------------------------------------------------------------------------
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- MODIFY: shift_assignments
-- ---------------------------------------------------------------------------
-- Add exact operational hours allowing assignments to partially cover shift templates.
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS actual_start_time TIMESTAMPTZ;
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS actual_end_time TIMESTAMPTZ;

-- Maintain data integrity if partial hours are provided.
ALTER TABLE shift_assignments ADD CONSTRAINT shift_assignments_actual_times_check
    CHECK (
        (actual_start_time IS NULL AND actual_end_time IS NULL) OR 
        (actual_end_time > actual_start_time)
    );
