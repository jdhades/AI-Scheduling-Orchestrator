-- =============================================================================
-- Custom Access Token Hook — versión Supabase Cloud (función en public)
-- =============================================================================
-- Supabase Cloud no permite CREATE FUNCTION en schema `auth` (ni el
-- project owner). Variante: definir la function en `public` y configurar
-- el hook desde Dashboard → Auth → Hooks → Customize Access Token con
-- schema=public, function=custom_access_token_hook.
--
-- Aplicar:
--   1) Dashboard → SQL Editor → pegar este archivo → Run.
--   2) Dashboard → Authentication → Hooks → Customize Access Token:
--      - Enable hook: ON
--      - Hook type: Postgres
--      - Schema: public
--      - Function: custom_access_token_hook
--      - Save
--   3) Logout + login para emitir un JWT con los custom claims.
--
-- Qué hace:
--   Enriquece el JWT con company_id, employee_id, employee_role,
--   department_id leídos desde public.employees por auth_user_id.
--   Sin esto, el WS gateway rechaza conexiones (necesita el claim).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE PLPGSQL STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claims JSONB;
  emp RECORD;
BEGIN
  claims := event->'claims';

  SELECT id, company_id, role, department_id
    INTO emp
  FROM public.employees
  WHERE auth_user_id = (event->>'user_id')::UUID;

  IF FOUND THEN
    claims := claims || jsonb_build_object(
      'company_id', emp.company_id::text,
      'employee_id', emp.id::text,
      'employee_role', emp.role,
      'department_id', COALESCE(emp.department_id::text, '')
    );
  END IF;

  RETURN jsonb_build_object('claims', claims);
END;
$$;

-- Permission grants — Supabase ejecuta el hook como rol `supabase_auth_admin`
-- (gotrue). Sin estos grants la function se invoca pero la lectura de
-- employees falla.
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB)
  TO supabase_auth_admin;
GRANT SELECT ON public.employees TO supabase_auth_admin;

-- Bypass de RLS para supabase_auth_admin sobre employees — el hook
-- corre en el contexto del JWT que se está emitiendo (todavía no hay
-- session), así que el policy de "owner ve los suyos" no aplica.
-- (Postgres no acepta IF NOT EXISTS en CREATE POLICY → usar DROP IF.)
DROP POLICY IF EXISTS employees_auth_hook_read ON public.employees;
CREATE POLICY employees_auth_hook_read
  ON public.employees FOR SELECT TO supabase_auth_admin
  USING (true);
