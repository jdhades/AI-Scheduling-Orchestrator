-- ============================================================
-- Escenario 4 — Canal Conversacional WhatsApp
-- Fecha: 2026-03-05
-- ============================================================

-- 1. Solicitudes de intercambio de turno
CREATE TABLE IF NOT EXISTS shift_swap_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL,
    requester_id    UUID NOT NULL REFERENCES employees(id),
    target_id       UUID NOT NULL REFERENCES employees(id),
    shift_id        UUID NOT NULL REFERENCES shifts(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Reportes de ausencia
CREATE TABLE IF NOT EXISTS absence_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL,
    employee_id     UUID NOT NULL REFERENCES employees(id),
    shift_id        UUID NOT NULL,
    reason          TEXT NOT NULL,
    is_urgent       BOOLEAN DEFAULT false,
    reported_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Solicitudes de días libres
CREATE TABLE IF NOT EXISTS day_off_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL,
    employee_id     UUID NOT NULL REFERENCES employees(id),
    date            DATE NOT NULL,
    reason          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Columna para marcar turnos que necesitan reemplazo urgente
ALTER TABLE shift_assignments
    ADD COLUMN IF NOT EXISTS needs_replacement BOOLEAN DEFAULT false;

-- 5. Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS shift_swap_requests_company_idx
    ON shift_swap_requests (company_id, status);

CREATE INDEX IF NOT EXISTS absence_reports_company_shift_idx
    ON absence_reports (company_id, shift_id);

CREATE INDEX IF NOT EXISTS day_off_requests_company_employee_idx
    ON day_off_requests (company_id, employee_id, date);

-- 6. Row Level Security — aislamiento de tenant
ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE absence_reports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_off_requests    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON shift_swap_requests
    USING (company_id = current_setting('app.company_id')::uuid);

CREATE POLICY "tenant_isolation" ON absence_reports
    USING (company_id = current_setting('app.company_id')::uuid);

CREATE POLICY "tenant_isolation" ON day_off_requests
    USING (company_id = current_setting('app.company_id')::uuid);
