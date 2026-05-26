-- =============================================================================
-- Fix: unique de email por company excluye soft-deleted
-- =============================================================================
-- El index creado en 20260526000000 era:
--   UNIQUE (company_id, lower(email)) WHERE email IS NOT NULL
--
-- Problema: un employee soft-deleted (deleted_at NOT NULL) seguía
-- ocupando el slot. UX: el manager borra a Juan (que tenía juan@x.com),
-- intenta darle ese mismo email a Pedro y choca con 409 "already exists".
--
-- Fix: agregar `AND deleted_at IS NULL` al WHERE.
-- =============================================================================

DROP INDEX IF EXISTS public.employees_company_email_uniq;

CREATE UNIQUE INDEX employees_company_email_uniq
  ON public.employees (company_id, lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
