-- =============================================================================
-- Invitation flow (PR 7 del sprint Auth) — partes en public.*
-- =============================================================================
-- La función `auth.handle_new_user()` y el TRIGGER `on_auth_user_created`
-- (originalmente en este archivo) se movieron a `supabase/sql-extra/
-- auth_setup.sql` — requieren rol `supabase_admin` para crear, y postgres
-- (que usa `supabase start`) no tiene CREATE en schema `auth`. Acá quedan
-- solo los ALTER TABLE en public.*.
-- =============================================================================

-- ─── 1. employees.phone_number → nullable ───────────────────────────────────
-- Schema legacy requería phone_number NOT NULL (path WhatsApp). Con el
-- nuevo flow de invitación email-only para managers, no siempre hay
-- phone — el manager corporativo no usa WhatsApp. Default a string vacío
-- mantiene compat con queries que asumen no-null.

ALTER TABLE public.employees
  ALTER COLUMN phone_number DROP NOT NULL;

-- Nullable invited_by para tolerar el DEV bypass (user sin employee
-- linkeado). En prod con auth real, siempre tendrá valor — la
-- aplicación lo enforza via @CurrentUser.employeeId.
ALTER TABLE public.auth_invitations
  ALTER COLUMN invited_by DROP NOT NULL;

-- ─── 2. Trigger handle_new_user → ver sql-extra/auth_setup.sql ──────────────
-- La definición vive en `supabase/sql-extra/auth_setup.sql`. Esta migration
-- no la puede crear porque CREATE FUNCTION en schema `auth` requiere
-- supabase_admin (postgres no tiene CREATE ahí). Apply manual:
--   docker exec -i supabase_db_xxx psql -U supabase_admin -d postgres \
--     < supabase/sql-extra/auth_setup.sql

-- Grants para que el SECURITY DEFINER del trigger pueda escribir en public.
-- Estos sí funcionan como postgres (es el owner de las tablas public).
GRANT SELECT, UPDATE ON public.auth_invitations TO postgres;
GRANT INSERT ON public.employees TO postgres;
