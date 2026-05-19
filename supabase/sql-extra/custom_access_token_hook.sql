-- =============================================================================
-- Custom Access Token Hook — APLICACIÓN MANUAL (NO es una migration auto-aplicada)
-- =============================================================================
-- Por qué está acá y NO en `supabase/migrations/`:
--   `supabase start` corre las migrations como rol `postgres`, que NO tiene
--   CREATE en el schema `auth`. Si este archivo está en migrations/, el
--   start falla y no levanta la stack. Por eso vive en `sql-extra/` y se
--   aplica explícitamente.
--
-- Cómo aplicarlo (local dev, una vez después del primer `supabase start`):
--   docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
--     psql -U supabase_admin -d postgres < supabase/sql-extra/custom_access_token_hook.sql
--
-- Cómo aplicarlo (Supabase Cloud / self-hosted prod):
--   Dashboard → SQL Editor → ejecutar este archivo como project owner.
--
-- Activación del hook (necesario además de crear la función):
--   - Local: declarado en `supabase/config.toml` bajo
--     [auth.hook.custom_access_token]. Lo levanta `supabase start`.
--   - Supabase Cloud: Dashboard → Auth → Hooks → Customize Access Token →
--     seleccionar `auth.custom_access_token_hook`.
--   - Self-hosted (docker compose):
--       GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
--       GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/auth/custom_access_token_hook
--     y restart del container `supabase_auth`.
--
-- Qué hace:
--   Supabase invoca esta function al emitir un access token (login + refresh).
--   Recibe `event` con los claims default; devuelve `event.claims` aumentado
--   con company_id, employee_id, employee_role, department_id resueltos
--   desde `public.employees`. Permite que `JwtValidatorService` lea el
--   tenant del JWT sin tocar DB.
--
-- Hasta que el hook esté activo, los JWT salen sin custom claims y el
-- guard cae a Path B (lookup `employees` por `auth_user_id`) — más caro
-- pero funcional. Una vez activo, automáticamente usa Path A.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE PLPGSQL STABLE
SECURITY DEFINER
-- Restringe el search_path para evitar function-name shadowing del
-- caller. Best practice de seguridad en funciones SECURITY DEFINER.
SET search_path = ''
AS $$
DECLARE
  claims JSONB;
  emp RECORD;
BEGIN
  claims := event->'claims';

  -- Lookup en public.employees por auth_user_id (sumado en PR 1).
  -- Si el user fue creado por signup directo (sin invitación + trigger),
  -- el row no existe todavía y `emp.id` queda NULL. El guard del backend
  -- maneja ese caso (lookup fallback) — acá solo enriquecemos cuando
  -- hay match.
  SELECT id, company_id, role, department_id
    INTO emp
  FROM public.employees
  WHERE auth_user_id = (event->>'user_id')::UUID;

  IF FOUND THEN
    claims := claims || jsonb_build_object(
      'company_id', emp.company_id::text,
      'employee_id', emp.id::text,
      'employee_role', emp.role,
      'department_id', emp.department_id::text
    );
  END IF;

  RETURN jsonb_build_object('claims', claims);
END;
$$;

-- Permission grant — Supabase ejecuta el hook como rol `supabase_auth_admin`
-- (gotrue). Sin grant, la function se invoca pero `SELECT` falla por RLS
-- (RLS sobre employees viene en PR 6 todavía, pero adelantamos el grant).
GRANT EXECUTE ON FUNCTION auth.custom_access_token_hook(JSONB)
  TO supabase_auth_admin;

-- Permitir al supabase_auth_admin leer employees para el lookup interno.
-- Cuando PR 6 habilite RLS, agregamos policy explícita; por ahora el
-- grant de SELECT directo cubre el caso.
GRANT SELECT ON public.employees TO supabase_auth_admin;
