-- =============================================================================
-- Platform admin — operadores de plataforma cross-tenant
-- =============================================================================
-- Habilita el "super admin" panel para vos (Jean / operador) y futuros
-- platform engineers. Diferencia con `employees.role='owner'`:
--   - owner: dueño de UNA company. Ve solo esa.
--   - platform_admin: opera la plataforma. Ve TODAS las companies.
--
-- Implementación: tabla separada `platform_admins` (no en employees.role
-- enum) porque platform_admin no está atado a un tenant. Una persona
-- puede ser ambas cosas (owner de Demo Co + platform_admin) — se decide
-- por contexto: dentro de su tenant es owner, en /admin es platform_admin.
--
-- RLS: el helper `auth.is_platform_admin()` devuelve true si auth.uid()
-- está en la tabla. Una policy adicional en `companies` (y cualquier
-- otra que el panel necesite) le da acceso full cuando el helper es true.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.platform_admins (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(auth_user_id)
);

CREATE INDEX IF NOT EXISTS platform_admins_email_idx
  ON public.platform_admins(email);

-- RLS: solo platform admins ven/modifican la tabla. Defensa contra que
-- un employee del tenant haga lookup vía Supabase client directo.
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Helper: STABLE para que el planner lo cachee dentro del query.
CREATE OR REPLACE FUNCTION auth.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE auth_user_id = auth.uid()
  );
$$;
GRANT EXECUTE ON FUNCTION auth.is_platform_admin() TO authenticated, anon, service_role;

-- Policy de la tabla misma — solo los platform admins se ven entre sí.
DROP POLICY IF EXISTS platform_admins_self ON public.platform_admins;
CREATE POLICY platform_admins_self ON public.platform_admins
  FOR ALL TO authenticated
  USING (auth.is_platform_admin())
  WITH CHECK (auth.is_platform_admin());

-- Policy cross-tenant en companies — platform_admin ve y edita todo.
-- La policy genérica `tenant_isolation` sigue activa para non-admins.
-- PostgreSQL evalúa policies en OR: si CUALQUIERA matchea, el row pasa.
DROP POLICY IF EXISTS companies_platform_admin_all ON public.companies;
CREATE POLICY companies_platform_admin_all ON public.companies
  FOR ALL TO authenticated
  USING (auth.is_platform_admin())
  WITH CHECK (auth.is_platform_admin());

-- Permisos para que el trigger / endpoints administrativos puedan
-- escribir vía service_role (que ya bypasea RLS) y vía authenticated
-- cuando es platform admin.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_admins TO postgres;

-- Seed: promover manager@demo.local a platform_admin para que vos
-- (Jean) puedas entrar al panel desde el dev local. Idempotente.
INSERT INTO public.platform_admins (auth_user_id, email)
SELECT u.id, u.email
FROM auth.users u
WHERE u.email = 'manager@demo.local'
ON CONFLICT (auth_user_id) DO NOTHING;
