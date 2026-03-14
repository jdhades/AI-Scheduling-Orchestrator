-- =============================================================================
-- MIGRATION: 20260310000000_scenario6_availability_preferences.sql
-- AI Scheduling Orchestrator — Domain Model Refinement Phase 1
-- =============================================================================

-- 1. Add minimum gap between shifts to companies
ALTER TABLE companies ADD COLUMN min_gap_between_shifts_hours INTEGER NOT NULL DEFAULT 12;

-- 2. TABLE: employee_availability
CREATE TABLE employee_availability (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    day_of_week     INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0=Sun, 1=Mon, ..., 6=Sat
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_time > start_time)
);

-- 3. TABLE: employee_preferences
CREATE TABLE employee_preferences (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    preference_type TEXT NOT NULL CHECK (preference_type IN ('PREFERS_MORNING', 'PREFERS_EVENING', 'PREFERS_NIGHT', 'AVOID_WEEKENDS', 'PREFERS_WEEKENDS')),
    weight          INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1 AND weight <= 5),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, preference_type)
);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================

ALTER TABLE employee_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_preferences  ENABLE ROW LEVEL SECURITY;

-- Associate rows to current tenant using the company_id derived from the employee record
CREATE POLICY tenant_isolation ON employee_availability
    USING (
        employee_id IN (
            SELECT id FROM employees WHERE company_id = current_tenant_id()
        )
    );

CREATE POLICY tenant_isolation ON employee_preferences
    USING (
        employee_id IN (
            SELECT id FROM employees WHERE company_id = current_tenant_id()
        )
    );
