-- =============================================================================
-- MIGRATION: shift model rework
-- De instancias diarias en `shifts` a templates + membresías + assignments concretos.
-- La generación del horario deja de persistir shifts; los materializa virtualmente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. shift_templates: day_of_week pasa a nullable (null = aplica todos los días)
-- ---------------------------------------------------------------------------
ALTER TABLE shift_templates ALTER COLUMN day_of_week DROP NOT NULL;

-- Mantener CHECK para que si viene un valor, sea 0..6
ALTER TABLE shift_templates DROP CONSTRAINT IF EXISTS shift_templates_day_of_week_check;
ALTER TABLE shift_templates ADD CONSTRAINT shift_templates_day_of_week_check
    CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6));

COMMENT ON COLUMN shift_templates.day_of_week IS
    '0..6 (0=Sun) para día específico; NULL = aplica todos los días.';
COMMENT ON COLUMN shift_templates.required_employees IS
    'NULL = slot opcional (no se fuerza cobertura); número > 0 = cuota mínima obligatoria.';

-- ---------------------------------------------------------------------------
-- 2. shift_memberships (nueva tabla)
-- Asocia empleados a templates. Reemplaza la idea de "asignar día por día".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_memberships (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id       UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    template_id       UUID NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
    effective_from    DATE NOT NULL,
    effective_until   DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (effective_until IS NULL OR effective_until >= effective_from),
    UNIQUE (employee_id, template_id, effective_from)
);

ALTER TABLE shift_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_memberships
    USING (company_id = current_tenant_id());

CREATE INDEX shift_memberships_company_idx ON shift_memberships(company_id);
CREATE INDEX shift_memberships_employee_idx ON shift_memberships(employee_id);
CREATE INDEX shift_memberships_template_idx ON shift_memberships(template_id);
CREATE INDEX shift_memberships_active_idx ON shift_memberships(effective_from, effective_until);

COMMENT ON TABLE shift_memberships IS
    'Asocia un empleado con un shift_template durante un rango de fechas. Source of truth de quién pertenece a qué turno.';

-- ---------------------------------------------------------------------------
-- 3. shift_assignments: restructurar (destructivo, datos ya purgados)
-- ---------------------------------------------------------------------------

-- Drop dependencias (policies que referencian shift_id, constraints)
DROP POLICY IF EXISTS tenant_isolation ON shift_assignments;
ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_shift_id_fkey;
ALTER TABLE shift_assignments DROP CONSTRAINT IF EXISTS shift_assignments_shift_id_fkey;
ALTER TABLE shift_assignments DROP CONSTRAINT IF EXISTS shift_assignments_pkey;

-- Remover columnas obsoletas
ALTER TABLE shift_assignments DROP COLUMN IF EXISTS shift_id;

-- Recrear policy RLS usando company_id (que ya existe en la tabla)
CREATE POLICY tenant_isolation ON shift_assignments
    USING (company_id = current_tenant_id());

-- Agregar nuevas columnas
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS template_id UUID
    REFERENCES shift_templates(id) ON DELETE CASCADE;
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS origin TEXT
    CHECK (origin IN ('membership', 'override', 'exception'));

-- id: garantizar que sea PK sola
ALTER TABLE shift_assignments ALTER COLUMN id SET NOT NULL;
ALTER TABLE shift_assignments ALTER COLUMN id SET DEFAULT uuid_generate_v4();
ALTER TABLE shift_assignments ADD PRIMARY KEY (id);

-- NOT NULL en los campos críticos (tabla vacía tras purga, seguro)
ALTER TABLE shift_assignments ALTER COLUMN template_id SET NOT NULL;
ALTER TABLE shift_assignments ALTER COLUMN date SET NOT NULL;
ALTER TABLE shift_assignments ALTER COLUMN origin SET NOT NULL;

-- Índices para queries frecuentes
CREATE INDEX IF NOT EXISTS shift_assignments_company_date_idx
    ON shift_assignments(company_id, date);
CREATE INDEX IF NOT EXISTS shift_assignments_employee_date_idx
    ON shift_assignments(employee_id, date);
CREATE INDEX IF NOT EXISTS shift_assignments_template_date_idx
    ON shift_assignments(template_id, date);

-- Constraint: un empleado no puede tener el mismo slot duplicado el mismo día
CREATE UNIQUE INDEX IF NOT EXISTS shift_assignments_no_dup_idx
    ON shift_assignments(employee_id, template_id, date);

COMMENT ON COLUMN shift_assignments.template_id IS 'FK a shift_templates — el slot que se está asignando.';
COMMENT ON COLUMN shift_assignments.date IS 'Fecha concreta de la asignación (YYYY-MM-DD).';
COMMENT ON COLUMN shift_assignments.origin IS 'membership=derivado de shift_memberships; override=puesto manualmente; exception=fuera de membership.';

-- ---------------------------------------------------------------------------
-- 4. shift_swap_requests: migrar FK a shift_assignments
-- ---------------------------------------------------------------------------
ALTER TABLE shift_swap_requests RENAME COLUMN shift_id TO shift_assignment_id;
ALTER TABLE shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_assignment_fkey
    FOREIGN KEY (shift_assignment_id)
    REFERENCES shift_assignments(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. absence_reports: migrar shift_id → shift_assignment_id (sin FK previa, agregarla)
-- ---------------------------------------------------------------------------
ALTER TABLE absence_reports RENAME COLUMN shift_id TO shift_assignment_id;
ALTER TABLE absence_reports
    ADD CONSTRAINT absence_reports_assignment_fkey
    FOREIGN KEY (shift_assignment_id)
    REFERENCES shift_assignments(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. DROP tabla shifts (ya no existe concepto de instancia diaria persistida)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS shifts CASCADE;
