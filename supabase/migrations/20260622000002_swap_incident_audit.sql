-- MIGRATION: integridad de datos — swaps + incidents (paridad con day-offs).
--
-- Soft-delete (no perder historial al cancelar) + atribución de la decisión
-- (quién/cuándo). `shift_swap_requests.approved_by` ya existía (se setea solo
-- en auto-approve); ahora también en approvals manuales + decided_at.

ALTER TABLE public.shift_swap_requests
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ NULL;

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS resolved_by UUID NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS shift_swap_requests_active_idx
  ON public.shift_swap_requests(company_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_active_idx
  ON public.incidents(company_id, status)
  WHERE deleted_at IS NULL;
