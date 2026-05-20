-- =============================================================================
-- Demo data para la company de `manager@demo.local` (alternegocio).
-- =============================================================================
-- Set retail con 3 depts, 5 skills, 8 empleados (incl. owner), 5 templates,
-- 6 memberships recurrentes, 3 policies, 14 tareas (12 template + 2 employee).
--
-- Apply (idempotente — usa ON CONFLICT DO NOTHING + UPDATE):
--   docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
--     psql -U postgres -d postgres < supabase/sql-extra/demo-data.sql
--
-- NO se aplica automáticamente con `supabase start` — viene fuera del
-- directorio `migrations/`. Diseñado para re-cargar cuando se quiera
-- reset rápido del estado de demo.
-- =============================================================================

DO $$
DECLARE
  v_company_id    UUID := 'e07e97a4-3e86-4a48-a3e6-8b08d276f9dd';
  v_owner_id      UUID := '960b4d42-c8ba-4d37-ad2c-e25b0d0abf79';
  v_branch_id     UUID := '217507a3-939f-494c-aa3c-837ca373bdcf';

  -- Departments
  v_dept_tienda   UUID := '71000000-0000-0000-0000-000000000001';
  v_dept_caja     UUID := '71000000-0000-0000-0000-000000000002';
  v_dept_deposito UUID := '71000000-0000-0000-0000-000000000003';

  -- Skills (catálogo global) — IDs resueltos por nombre.
  v_skill_atencion   UUID;
  v_skill_caja_reg   UUID;
  v_skill_inventario UUID;
  v_skill_vm         UUID;
  v_skill_ingles     UUID;

  -- Employees
  v_emp_carolina  UUID := '73000000-0000-0000-0000-000000000001';
  v_emp_martin    UUID := '73000000-0000-0000-0000-000000000002';
  v_emp_lucia     UUID := '73000000-0000-0000-0000-000000000003';
  v_emp_diego     UUID := '73000000-0000-0000-0000-000000000004';
  v_emp_sofia     UUID := '73000000-0000-0000-0000-000000000005';
  v_emp_roberto   UUID := '73000000-0000-0000-0000-000000000006';
  v_emp_florencia UUID := '73000000-0000-0000-0000-000000000007';

  -- Templates
  v_tpl_tienda_m UUID := '74000000-0000-0000-0000-000000000001';
  v_tpl_tienda_t UUID := '74000000-0000-0000-0000-000000000002';
  v_tpl_caja_m   UUID := '74000000-0000-0000-0000-000000000003';
  v_tpl_caja_t   UUID := '74000000-0000-0000-0000-000000000004';
  v_tpl_deposito UUID := '74000000-0000-0000-0000-000000000005';
BEGIN
  -- ─── 1. Limpieza de data de testing ─────────────────────────────────
  DELETE FROM public.tasks             WHERE company_id = v_company_id;
  DELETE FROM public.shift_assignments WHERE company_id = v_company_id;
  -- Cualquier template existente que no esté en mi set fijo lo borro
  -- (ej. el "Retail Diurno" de testing).
  DELETE FROM public.shift_templates
    WHERE company_id = v_company_id
      AND id NOT IN (
        v_tpl_tienda_m, v_tpl_tienda_t, v_tpl_caja_m,
        v_tpl_caja_t, v_tpl_deposito
      );

  -- ─── 2. Owner phone ────────────────────────────────────────────────
  UPDATE public.employees
    SET phone_number = '+15626954782'
    WHERE id = v_owner_id;

  -- ─── 3. Departamentos ──────────────────────────────────────────────
  INSERT INTO public.departments (id, branch_id, company_id, name) VALUES
    (v_dept_tienda,   v_branch_id, v_company_id, 'Tienda'),
    (v_dept_caja,     v_branch_id, v_company_id, 'Caja'),
    (v_dept_deposito, v_branch_id, v_company_id, 'Depósito')
  ON CONFLICT (id) DO NOTHING;

  -- ─── 4. Skills (catálogo global compartido) + asociación a company
  INSERT INTO public.skills (name) VALUES
    ('Atención al cliente'),
    ('Manejo de caja registradora'),
    ('Inventario'),
    ('Visual merchandising'),
    ('Inglés')
  ON CONFLICT (name) DO NOTHING;

  SELECT id INTO v_skill_atencion   FROM public.skills WHERE name = 'Atención al cliente';
  SELECT id INTO v_skill_caja_reg   FROM public.skills WHERE name = 'Manejo de caja registradora';
  SELECT id INTO v_skill_inventario FROM public.skills WHERE name = 'Inventario';
  SELECT id INTO v_skill_vm         FROM public.skills WHERE name = 'Visual merchandising';
  SELECT id INTO v_skill_ingles     FROM public.skills WHERE name = 'Inglés';

  INSERT INTO public.company_skills (company_id, skill_id) VALUES
    (v_company_id, v_skill_atencion),
    (v_company_id, v_skill_caja_reg),
    (v_company_id, v_skill_inventario),
    (v_company_id, v_skill_vm),
    (v_company_id, v_skill_ingles)
  ON CONFLICT DO NOTHING;

  -- ─── 5. Employees ──────────────────────────────────────────────────
  INSERT INTO public.employees
    (id, company_id, department_id, name, phone_number, role, whatsapp_verified, hire_date)
  VALUES
    (v_emp_carolina,  v_company_id, v_dept_tienda,   'Carolina Pérez',  '+14155550101', 'manager',  false, '2024-01-15'),
    (v_emp_martin,    v_company_id, v_dept_tienda,   'Martín Sosa',     '+14155550102', 'employee', false, '2024-03-01'),
    (v_emp_lucia,     v_company_id, v_dept_tienda,   'Lucía Ramírez',   '+14155550103', 'employee', false, '2024-04-10'),
    (v_emp_diego,     v_company_id, v_dept_caja,     'Diego Torres',    '+14155550104', 'employee', false, '2024-02-20'),
    (v_emp_sofia,     v_company_id, v_dept_caja,     'Sofía Méndez',    '+14155550105', 'employee', false, '2024-05-05'),
    (v_emp_roberto,   v_company_id, v_dept_deposito, 'Roberto Vega',    '+14155550106', 'employee', false, '2024-01-22'),
    (v_emp_florencia, v_company_id, v_dept_deposito, 'Florencia Ruiz',  '+14155550107', 'employee', false, '2024-06-15')
  ON CONFLICT (id) DO NOTHING;

  -- ─── 6. Shift templates ────────────────────────────────────────────
  -- day_of_week=NULL → aplica a cualquier día. El manager especializa
  -- por día desde la UI si lo necesita.
  INSERT INTO public.shift_templates
    (id, company_id, department_id, name, day_of_week, start_time, end_time, required_employees)
  VALUES
    (v_tpl_tienda_m, v_company_id, v_dept_tienda,   'Tienda Mañana', NULL, '09:00:00', '15:00:00', 2),
    (v_tpl_tienda_t, v_company_id, v_dept_tienda,   'Tienda Tarde',  NULL, '15:00:00', '21:00:00', 2),
    (v_tpl_caja_m,   v_company_id, v_dept_caja,     'Caja Mañana',   NULL, '09:00:00', '15:00:00', 1),
    (v_tpl_caja_t,   v_company_id, v_dept_caja,     'Caja Tarde',    NULL, '15:00:00', '21:00:00', 1),
    (v_tpl_deposito, v_company_id, v_dept_deposito, 'Depósito',      NULL, '07:00:00', '13:00:00', 1)
  ON CONFLICT (id) DO NOTHING;

  -- ─── 7. Shift memberships (recurrencias) ──────────────────────────
  INSERT INTO public.shift_memberships
    (company_id, employee_id, template_id, effective_from)
  VALUES
    (v_company_id, v_emp_carolina, v_tpl_tienda_m, '2026-01-01'),
    (v_company_id, v_emp_martin,   v_tpl_tienda_m, '2026-01-01'),
    (v_company_id, v_emp_lucia,    v_tpl_tienda_t, '2026-01-01'),
    (v_company_id, v_emp_diego,    v_tpl_caja_m,   '2026-01-01'),
    (v_company_id, v_emp_sofia,    v_tpl_caja_t,   '2026-01-01'),
    (v_company_id, v_emp_roberto,  v_tpl_deposito, '2026-01-01')
  ON CONFLICT DO NOTHING;

  -- ─── 8. Company policies ──────────────────────────────────────────
  INSERT INTO public.company_policies
    (company_id, text, severity, scope_type, is_active, effective_from, params)
  VALUES
    (v_company_id, 'Mínimo 11 horas de descanso entre turnos',           'hard', 'company', true, '2026-01-01', '{}'::jsonb),
    (v_company_id, 'Cada empleado al menos 2 días libres por semana',    'hard', 'company', true, '2026-01-01', '{}'::jsonb),
    (v_company_id, 'Evitar más de 5 turnos seguidos sin día libre',      'soft', 'company', true, '2026-01-01', '{}'::jsonb);

  -- ─── 9. Tasks por template ────────────────────────────────────────
  INSERT INTO public.tasks (company_id, shift_template_id, title, description) VALUES
    (v_company_id, v_tpl_tienda_m, 'Abrir local + encender luces',             NULL),
    (v_company_id, v_tpl_tienda_m, 'Reponer góndolas faltantes',               'Revisar zona de novedades y rotación lenta'),
    (v_company_id, v_tpl_tienda_m, 'Verificar precios del día',                NULL),
    (v_company_id, v_tpl_tienda_t, 'Hacer cierre de caja parcial 18hs',        NULL),
    (v_company_id, v_tpl_tienda_t, 'Cerrar local + apagar luces',              'Confirmar que las cortinas eléctricas estén cerradas'),
    (v_company_id, v_tpl_tienda_t, 'Sacar la basura',                          NULL),
    (v_company_id, v_tpl_caja_m,   'Contar caja inicial',                      'Fondo de caja inicial: $5000'),
    (v_company_id, v_tpl_caja_m,   'Verificar terminal de pago',               NULL),
    (v_company_id, v_tpl_caja_t,   'Arqueo de cierre',                         NULL),
    (v_company_id, v_tpl_caja_t,   'Backup del POS',                           'Conectar el USB azul y esperar confirmación'),
    (v_company_id, v_tpl_deposito, 'Recibir entregas del día',                 NULL),
    (v_company_id, v_tpl_deposito, 'Actualizar inventario',                    'Sólo los SKUs que se movieron en el día');

  -- ─── 10. Tasks por empleado ───────────────────────────────────────
  INSERT INTO public.tasks (company_id, employee_id, title, description) VALUES
    (v_company_id, v_emp_carolina, 'Reunión 1:1 con Diego — feedback mensual',   'Revisar metas Q2, agenda 30min'),
    (v_company_id, v_emp_martin,   'Completar curso online de visual merchandising', 'Link en el portal interno');
END $$;
