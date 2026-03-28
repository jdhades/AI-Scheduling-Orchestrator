-- Use the default company
WITH target_company AS (
    SELECT id FROM "public"."companies" WHERE id = '11111111-2222-3333-4444-555555555555' LIMIT 1
),
test_user AS (
    -- Our test user
    SELECT id FROM "public"."employees" WHERE phone_number = '+15616954782' LIMIT 1
),
colleague AS (
    -- Any other user
    SELECT id FROM "public"."employees" WHERE phone_number != '+15616954782' LIMIT 1
),
-- Insert Shifts
new_shifts AS (
    INSERT INTO "public"."shifts" (
        id, company_id, start_time, end_time, required_skill_level, required_experience_months, demand_score, undesirable_weight
    )
    VALUES
    (
        gen_random_uuid(), (SELECT id FROM target_company), CURRENT_TIMESTAMP + interval '1 day' + interval '8 hours', CURRENT_TIMESTAMP + interval '1 day' + interval '16 hours', 'junior', 0, 1, 1
    ),
    (
        gen_random_uuid(), (SELECT id FROM target_company), CURRENT_TIMESTAMP + interval '2 days' + interval '12 hours', CURRENT_TIMESTAMP + interval '2 days' + interval '20 hours', 'junior', 0, 1, 1
    ),
    (
        gen_random_uuid(), (SELECT id FROM target_company), CURRENT_TIMESTAMP + interval '3 days' + interval '10 hours', CURRENT_TIMESTAMP + interval '3 days' + interval '18 hours', 'junior', 0, 1, 1
    )
    RETURNING id
),
-- Group assigned IDs
shift_ids AS (
    SELECT id, row_number() OVER () as rnum FROM new_shifts
)
-- Insert Assignments
INSERT INTO "public"."shift_assignments" (
    id, shift_id, employee_id, company_id, assigned_at, assigned_by_strategy, fairness_snapshot
)
SELECT 
    gen_random_uuid(),
    (SELECT id FROM shift_ids WHERE rnum = 1),
    (SELECT id FROM test_user),
    (SELECT id FROM target_company),
    CURRENT_TIMESTAMP,
    'hybrid',
    '{}'::jsonb
UNION ALL
SELECT 
    gen_random_uuid(),
    (SELECT id FROM shift_ids WHERE rnum = 2),
    (SELECT id FROM colleague),
    (SELECT id FROM target_company),
    CURRENT_TIMESTAMP,
    'hybrid',
    '{}'::jsonb;
