-- =============================================================================
-- Default "Main" branch on self_signup company creation
-- =============================================================================
-- Sin esto, una company self_signup arranca sin branches y el owner no
-- puede crear departments (FK departments.branch_id NOT NULL).
--
-- Extendemos handle_new_user → en el path self_signup, después de crear
-- la company + el owner employee, creamos también una branch "Main"
-- con el timezone detectado del browser (almacenado en metadata) o UTC.
-- =============================================================================

-- handle_new_user → ver sql-extra/auth_setup.sql
-- Esta migration redefinía la función para sumar el path "default branch
-- Main". La versión final consolidada (con esta extensión) vive en
-- `supabase/sql-extra/auth_setup.sql`. CREATE FUNCTION en `auth` requiere
-- supabase_admin (postgres no tiene CREATE ahí). Apply: ver header.

GRANT INSERT ON public.branches TO postgres;

-- Backfill: companies self_signup que se crearon sin branch obtienen "Main".
INSERT INTO public.branches (company_id, name, timezone)
SELECT c.id, 'Main', 'UTC'
FROM public.companies c
LEFT JOIN public.branches b ON b.company_id = c.id
WHERE b.id IS NULL
  AND c.created_via IN ('self_signup', 'sql_seed');
