-- MIGRATION: import revert capability.
--
-- Suma snapshot pre-commit + estado 'reverted' a imports_staging para
-- que el owner pueda deshacer una importación commiteada por error.
--
-- Política de window: el endpoint del controller rechaza revert si
-- committed_at > 7 días para evitar destruir cambios manuales
-- posteriores. Hoy es hard-coded en el controller; si en el futuro
-- pasa a ser config-per-tenant, sumar una columna a companies.

-- 1. pre_commit_snapshot — JSON con los rows afectados antes del commit.
--    Formato (puede variar entre versiones del committer):
--      {
--        "updated_branches":     [{ "id": "...", ...full row... }, ...],
--        "updated_departments":  [{ "id": "...", ...full row... }, ...],
--        "updated_employees":    [{ "id": "...", ...full row... }, ...],
--        "updated_company_skills":[{ "id": "...", ...full row... }, ...]
--      }
--    Los IDs de filas CREATED ya viven en commit_report.entities.* —
--    no se duplican acá. Revert los borra usando esos ids.
ALTER TABLE public.imports_staging
  ADD COLUMN IF NOT EXISTS pre_commit_snapshot JSONB NULL;

COMMENT ON COLUMN public.imports_staging.pre_commit_snapshot IS
  'Snapshot de filas existentes que el commit estaba por modificar. Usado por POST /imports/staging/:id/revert para restaurar valores previos. IDs de filas creadas vienen de commit_report; este campo solo guarda updates.';

-- 2. reverted_at — timestamp del revert, null si nunca se revirtió.
ALTER TABLE public.imports_staging
  ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ NULL;

-- 3. Extender el CHECK del status para sumar 'reverted'.
ALTER TABLE public.imports_staging
  DROP CONSTRAINT IF EXISTS imports_staging_status_check;

ALTER TABLE public.imports_staging
  ADD CONSTRAINT imports_staging_status_check
  CHECK (status IN (
    'extracting',
    'pending_review',
    'confirming',
    'committed',
    'failed',
    'discarded',
    'reverted'
  ));
