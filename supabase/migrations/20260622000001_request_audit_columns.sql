-- MIGRATION: integridad de datos para reportes fidedignos.
--
-- 1) Soft-delete en preferencias y day-offs: dejar de borrar en duro para
--    conservar el historial (cuántas veces el empleado pidió y retiró). Las
--    ausencias ya usaban soft-delete; igualamos el resto.
-- 2) Atribución de la decisión en day-offs: quién (decided_by) y cuándo
--    (decided_at) aprobó/rechazó — antes solo se guardaba el `status`.

ALTER TABLE public.shift_preferences
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

ALTER TABLE public.day_off_requests
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS decided_by UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ NULL;

-- Índices parciales: los listados filtran deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS shift_preferences_active_idx
  ON public.shift_preferences(company_id, date)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS day_off_requests_active_idx
  ON public.day_off_requests(company_id, date)
  WHERE deleted_at IS NULL;
