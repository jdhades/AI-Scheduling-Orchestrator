-- Update Jorge to be a manager
UPDATE employees SET role = 'manager' WHERE name = 'Jorge Test';

-- Insert a shift for tomorrow for Jorge's company
WITH new_shift_1 AS (
    INSERT INTO shifts (id, company_id, start_time, end_time)
    SELECT gen_random_uuid(), company_id, current_date + interval '1 day' + interval '9 hours', current_date + interval '1 day' + interval '17 hours'
    FROM employees WHERE name = 'Jorge Test'
    RETURNING id, company_id
)
INSERT INTO shift_assignments (id, company_id, shift_id, employee_id, assigned_by_strategy)
SELECT gen_random_uuid(), s.company_id, s.id, e.id, 'hybrid'
FROM new_shift_1 s
CROSS JOIN (SELECT id FROM employees WHERE name = 'Jorge Test') e;

-- Insert a shift for the day after tomorrow
WITH new_shift_2 AS (
    INSERT INTO shifts (id, company_id, start_time, end_time)
    SELECT gen_random_uuid(), company_id, current_date + interval '2 days' + interval '10 hours', current_date + interval '2 days' + interval '18 hours'
    FROM employees WHERE name = 'Jorge Test'
    RETURNING id, company_id
)
INSERT INTO shift_assignments (id, company_id, shift_id, employee_id, assigned_by_strategy)
SELECT gen_random_uuid(), s.company_id, s.id, e.id, 'hybrid'
FROM new_shift_2 s
CROSS JOIN (SELECT id FROM employees WHERE name = 'Jorge Test') e;

SELECT name, role FROM employees WHERE name = 'Jorge Test';
SELECT count(*) FROM shifts;
SELECT count(*) FROM shift_assignments;
