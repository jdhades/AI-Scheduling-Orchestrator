-- =============================================================================
-- Custom Access Token Hook (PR 4 del sprint Auth)
-- =============================================================================
-- Function que Supabase invoca al emitir un access token (login + refresh).
-- Recibe `event` con los claims default; devuelve `event.claims` aumentados
-- con company_id, employee_id, role, department_id resueltos desde la tabla
-- `employees`. Eso permite que `JwtValidatorService` lea el tenant del JWT
-- sin tocar DB.
--
-- IMPORTANTE — registración del hook:
--   - Supabase Cloud: Dashboard → Auth → Hooks → Customize Access Token →
--     seleccionar `auth.custom_access_token_hook`.
--   - Self-hosted (docker compose):
--       GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
--       GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/auth/custom_access_token_hook
--     en el container `supabase_auth`. Restart del container.
--
-- IMPORTANTE — permisos: esta migration requiere rol `supabase_admin`
-- (la role `postgres` no tiene CREATE en el schema `auth`). Aplicación:
--   docker exec -i -e PGPASSWORD=postgres supabase_db_xxx \
--     psql -U supabase_admin -d postgres < <archivo>.sql
--
-- Hasta que el hook esté activo, los JWT salen sin custom claims. El
-- guard cae a `Path B` (lookup employees por auth_user_id) — más caro
-- pero funciona. Cuando el hook se habilite, el guard usa `Path A`
-- automáticamente (sin cambios de código).
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
