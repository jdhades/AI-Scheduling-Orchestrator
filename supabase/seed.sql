-- =============================================================================
-- SEED DATA: Test Scenario para "Crear reglas por WhatsApp"
-- Tenant: 1
-- Branch: 1
-- Department: 1
-- Manager: +15616954782
-- Empleados: 4 regulares
-- =============================================================================

DO $$
DECLARE
  v_company_id UUID := '10000000-0000-0000-0000-000000000001';
  v_branch_id UUID := '20000000-0000-0000-0000-000000000001';
  v_dept_id UUID := '30000000-0000-0000-0000-000000000001';
BEGIN

  -- 1. Insert Company
  INSERT INTO companies (id, name, allow_employee_swap, auto_notification)
  VALUES (v_company_id, 'Restaurante Test', true, true)
  ON CONFLICT (id) DO NOTHING;

  -- 2. Insert Branch
  INSERT INTO branches (id, company_id, name, timezone)
  VALUES (v_branch_id, v_company_id, 'Sucursal Central', 'UTC')
  ON CONFLICT (id) DO NOTHING;

  -- 3. Insert Department
  INSERT INTO departments (id, branch_id, company_id, name)
  VALUES (v_dept_id, v_branch_id, v_company_id, 'Cocina')
  ON CONFLICT (id) DO NOTHING;

  -- 4. Insert Manager
  INSERT INTO employees (id, company_id, department_id, name, phone_number, role, whatsapp_verified, hire_date)
  VALUES ('40000000-0000-0000-0000-000000000001', v_company_id, v_dept_id, 'Juan Manager', '+15616954782', 'manager', true, '2020-01-01')
  ON CONFLICT (id) DO NOTHING;

  -- 5. Insert Regular Employees (4 en total)
  INSERT INTO employees (id, company_id, department_id, name, phone_number, role, whatsapp_verified, hire_date)
  VALUES ('40000000-0000-0000-0000-000000000002', v_company_id, v_dept_id, 'Carlos Empleado', '+15000000001', 'employee', true, '2023-01-01')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO employees (id, company_id, department_id, name, phone_number, role, whatsapp_verified, hire_date)
  VALUES ('40000000-0000-0000-0000-000000000003', v_company_id, v_dept_id, 'Maria Empleado', '+15000000002', 'employee', true, '2023-02-01')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO employees (id, company_id, department_id, name, phone_number, role, whatsapp_verified, hire_date)
  VALUES ('40000000-0000-0000-0000-000000000004', v_company_id, v_dept_id, 'Ana Empleado', '+15000000003', 'employee', true, '2023-03-01')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO employees (id, company_id, department_id, name, phone_number, role, whatsapp_verified, hire_date)
  VALUES ('40000000-0000-0000-0000-000000000005', v_company_id, v_dept_id, 'Luis Empleado', '+15000000004', 'employee', true, '2023-04-01')
  ON CONFLICT (id) DO NOTHING;

  -- 6. Insert Shift Templates with NULL required_employees (Dynamic/Elastic mode for lazy clients)
  -- day_of_week is 0-6 (0 = Sun, 6 = Sat)
  FOR i IN 0..6 LOOP
    INSERT INTO shift_templates (company_id, department_id, name, day_of_week, start_time, end_time, required_employees)
    VALUES (v_company_id, v_dept_id, 'De 10am a 4pm', i, '10:00:00', '16:00:00', null);

    INSERT INTO shift_templates (company_id, department_id, name, day_of_week, start_time, end_time, required_employees)
    VALUES (v_company_id, v_dept_id, 'De 4pm a 10pm', i, '16:00:00', '22:00:00', null);
  END LOOP;

END $$;
