-- =============================================================================
-- Owner role — PR Owner Role del sprint Marketing/Onboarding
-- =============================================================================
-- Agrega el rol `'owner'` arriba de `'manager'`. Owner es quien crea la
-- company en el flujo self-signup (PR siguiente). Hereda todas las
-- capacidades del manager (mismo acceso a RLS). Lo único exclusivo de
-- owner viene en otro PR: pantalla Settings + promote/demote managers.
--
-- Cambios:
--   1. CHECK constraint en employees.role pasa de IN ('manager','employee')
--      a IN ('owner','manager','employee').
--   2. RLS policies que usan `public.user_role() = 'manager'` se amplían a
--      `public.user_role() IN ('owner','manager')`. Son 3 policies
--      (shift_assignments x2, auth_audit_log x1) — el resto de las 17
--      tablas tenant-scoped no gatean por rol, solo por company_id.
--   3. Promover al dev user `manager@demo.local` a 'owner' para que el
--      flujo del frontend pueda probar gating owner-only.
-- =============================================================================

-- ─── 1. CHECK constraint ───────────────────────────────────────────────────
-- Postgres no permite ALTER CHECK in-place; drop + add.
ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_role_check;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_role_check
  CHECK (role IN ('owner', 'manager', 'employee'));

-- ─── 2. RLS policies ───────────────────────────────────────────────────────
-- shift_assignments_employee_self_read: el owner ve todas las del tenant,
-- igual que manager.
DROP POLICY IF EXISTS shift_assignments_employee_self_read ON public.shift_assignments;
CREATE POLICY shift_assignments_employee_self_read ON public.shift_assignments
  FOR SELECT TO authenticated
  USING (
    company_id = public.user_company_id()
    AND (
      public.user_role() IN ('owner', 'manager')
      OR employee_id = COALESCE(
        public.user_employee_id(),
        (SELECT id FROM public.employees WHERE auth_user_id = auth.uid() LIMIT 1)
      )
    )
  );

-- shift_assignments_manager_all → renombrado conceptualmente, mantenemos
-- el nombre por consistencia con migrations previas. Owner+manager con
-- full access dentro de su company.
DROP POLICY IF EXISTS shift_assignments_manager_all ON public.shift_assignments;
CREATE POLICY shift_assignments_manager_all ON public.shift_assignments
  FOR ALL TO authenticated
  USING (
    company_id = public.user_company_id()
    AND public.user_role() IN ('owner', 'manager')
  )
  WITH CHECK (
    company_id = public.user_company_id()
    AND public.user_role() IN ('owner', 'manager')
  );

-- auth_audit_log: owner ve igual que manager.
DROP POLICY IF EXISTS auth_audit_log_manager_read ON public.auth_audit_log;
CREATE POLICY auth_audit_log_manager_read ON public.auth_audit_log
  FOR SELECT TO authenticated
  USING (
    company_id = public.user_company_id()
    AND public.user_role() IN ('owner', 'manager')
  );

-- ─── 3. Seed: promover manager@demo.local a owner ──────────────────────────
-- Idempotente: si el user no existe (entorno limpio sin seed-auth-user),
-- el UPDATE no afecta filas. Si ya está como owner, tampoco.
UPDATE public.employees e
SET role = 'owner'
FROM auth.users u
WHERE u.id = e.auth_user_id
  AND u.email = 'manager@demo.local'
  AND e.role <> 'owner';
