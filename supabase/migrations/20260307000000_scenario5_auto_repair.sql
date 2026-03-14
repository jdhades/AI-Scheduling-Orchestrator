-- Migración para el Escenario 5 - Auto-Repair Incident Engine

CREATE TABLE public.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  evidence_url text,
  ocr_text text,
  ocr_confidence float,
  validated boolean DEFAULT false,
  start_date date,
  end_date date,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX incidents_employee_idx ON public.incidents (employee_id);
CREATE INDEX incidents_company_idx ON public.incidents (company_id);
CREATE INDEX incidents_status_idx ON public.incidents (status);

-- RLS para incidents
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read for tenant users"
ON public.incidents FOR SELECT
USING (company_id = auth.uid()); -- Simulación RLS, asumiendo auth.uid() maneja tenant en la app real. Ajustar a la convención del proyecto.

CREATE POLICY "Enable insert for tenant users"
ON public.incidents FOR INSERT
WITH CHECK (company_id = auth.uid());

CREATE POLICY "Enable update for tenant users"
ON public.incidents FOR UPDATE
USING (company_id = auth.uid());


-- Tabla de Eventos de Incidencias (Outbox Pattern / Event Sourcing Audit)
CREATE TABLE public.incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX incident_events_incident_idx ON public.incident_events (incident_id);
CREATE INDEX incident_events_type_idx ON public.incident_events (event_type);

-- RLS para incident_events
ALTER TABLE public.incident_events ENABLE ROW LEVEL SECURITY;

-- Esta tabla es usada predominantemente por el backend, permitiendo full trust o reglas específicas:
CREATE POLICY "Enable all for trusted backend"
ON public.incident_events FOR ALL
USING (true) WITH CHECK (true); -- Ajustar a roles reales
