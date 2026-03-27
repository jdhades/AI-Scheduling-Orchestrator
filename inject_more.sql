-- Shift 1: Next Tuesday (4 days from today) 09:00 - 12:00
WITH new_shift_1 AS (
    INSERT INTO shifts (id, company_id, start_time, end_time)
    SELECT gen_random_uuid(), company_id, current_date + interval '4 days' + interval '9 hours', current_date + interval '4 days' + interval '12 hours'
    FROM employees WHERE name = 'Jorge Test'
    RETURNING id, company_id
)
INSERT INTO shift_assignments (id, company_id, shift_id, employee_id, assigned_by_strategy)
SELECT gen_random_uuid(), s.company_id, s.id, e.id, 'hybrid'
FROM new_shift_1 s
CROSS JOIN (SELECT id FROM employees WHERE name = 'Jorge Test') e;

-- Shift 2: Next Tuesday (4 days from today) 14:00 - 18:00
WITH new_shift_2 AS (
    INSERT INTO shifts (id, company_id, start_time, end_time)
    SELECT gen_random_uuid(), company_id, current_date + interval '4 days' + interval '14 hours', current_date + interval '4 days' + interval '18 hours'
    FROM employees WHERE name = 'Jorge Test'
    RETURNING id, company_id
)
INSERT INTO shift_assignments (id, company_id, shift_id, employee_id, assigned_by_strategy)
SELECT gen_random_uuid(), s.company_id, s.id, e.id, 'hybrid'
FROM new_shift_2 s
CROSS JOIN (SELECT id FROM employees WHERE name = 'Jorge Test') e;

-- Shift 3: Next Wednesday (5 days from today) 09:00 - 17:00
WITH new_shift_3 AS (
    INSERT INTO shifts (id, company_id, start_time, end_time)
    SELECT gen_random_uuid(), company_id, current_date + interval '5 days' + interval '9 hours', current_date + interval '5 days' + interval '17 hours'
    FROM employees WHERE name = 'Jorge Test'
    RETURNING id, company_id
)
INSERT INTO shift_assignments (id, company_id, shift_id, employee_id, assigned_by_strategy)
SELECT gen_random_uuid(), s.company_id, s.id, e.id, 'hybrid'
FROM new_shift_3 s
CROSS JOIN (SELECT id FROM employees WHERE name = 'Jorge Test') e;
