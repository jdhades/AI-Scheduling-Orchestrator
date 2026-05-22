-- MIGRATION: preferencias de equipo a nivel company.
-- Toggles owner-facing en Settings que afectan UX del producto (no
-- políticas de negocio, no features técnicas — esos viven en
-- company_policies y tenant_features respectivamente).

ALTER TABLE public.companies
  -- 'all' = empleados ven los turnos de sus compañeros en la grilla.
  -- 'own_only' = cada empleado solo ve sus propios turnos. Privacy.
  ADD COLUMN IF NOT EXISTS schedule_visibility_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (schedule_visibility_mode IN ('all', 'own_only')),

  -- 'public' = la disponibilidad de cada empleado es visible para sus
  -- pares (útil para planificar swaps). 'private' = solo el manager.
  ADD COLUMN IF NOT EXISTS availability_visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (availability_visibility IN ('public', 'private')),

  -- Días mínimos de aviso para que un empleado cambie su availability.
  -- 0 = puede cambiar sin restricción. >0 = el frontend bloquea cambios
  -- dentro de esa ventana. Gobernanza, no enforcement crítico.
  ADD COLUMN IF NOT EXISTS availability_change_notice_days INT NOT NULL DEFAULT 0
    CHECK (availability_change_notice_days >= 0 AND availability_change_notice_days <= 30),

  -- Si true, el empleado debe marcar explícitamente "leí el turno"
  -- después de generado. Auditoría útil para industrias con shifts
  -- críticos (turno noche, hospitales). Default off — menos fricción.
  ADD COLUMN IF NOT EXISTS shift_confirmation_required BOOLEAN NOT NULL DEFAULT false,

  -- Si false, oculta el módulo de Absences (KPIs + reportes) en el
  -- panel. Útil para companies que no quieren trackear ausencias o
  -- usan otro sistema. Default true — todos los tenants lo ven.
  ADD COLUMN IF NOT EXISTS absences_tracking_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.companies.schedule_visibility_mode IS
  'Privacy: all=empleados ven horario de pares; own_only=cada uno solo el suyo.';
COMMENT ON COLUMN public.companies.availability_visibility IS
  'Visibility de availability entre empleados. public=ven entre pares; private=solo manager.';
COMMENT ON COLUMN public.companies.availability_change_notice_days IS
  'Días de aviso mínimo para cambiar availability. 0=sin restricción.';
COMMENT ON COLUMN public.companies.shift_confirmation_required IS
  'Si true, el empleado debe confirmar explícitamente que vio su turno.';
COMMENT ON COLUMN public.companies.absences_tracking_enabled IS
  'Si false, oculta el módulo de Absences del panel del tenant.';
