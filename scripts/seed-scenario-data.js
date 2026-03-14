const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

// Connect to local Supabase using Service Role Key to bypass RLS policies
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'REDACTED_SUPABASE_SECRET';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const COMPANY_ID = '11111111-2222-3333-4444-555555555555';
const WEEK_START = '2024-03-04'; // Monday

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns employee_availability rows for typical Mon–Fri day schedule (9:00–17:00). */
function weekdayAvailability(employeeId) {
    return [1, 2, 3, 4, 5].map(day => ({
        id: uuidv4(),
        employee_id: employeeId,
        day_of_week: day,
        start_time: '09:00',
        end_time: '17:00',
    }));
}

/** Returns Mon–Fri evening/night availability (14:00–24:00 as 00:00 next day — stored as 00:00 end). */
function eveningAvailability(employeeId) {
    return [1, 2, 3, 4, 5].map(day => ({
        id: uuidv4(),
        employee_id: employeeId,
        day_of_week: day,
        start_time: '14:00',
        end_time: '23:59',
    }));
}

/** Returns full-week availability (all 7 days, any time) — used for flexible employees. */
function fullWeekAvailability(employeeId) {
    return [0, 1, 2, 3, 4, 5, 6].map(day => ({
        id: uuidv4(),
        employee_id: employeeId,
        day_of_week: day,
        start_time: '08:00',
        end_time: '23:59',
    }));
}

// ─── Main Seed ────────────────────────────────────────────────────────────────

async function seedData() {
    console.log('🌱 Starting Scenario 6 Data Seeding (Phase 1: Availability + Preferences)...');

    // ── 0. Company ────────────────────────────────────────────────────────────
    const { error: companyError } = await supabase.from('companies').upsert({
        id: COMPANY_ID,
        name: 'Restaurante Demo SaaS',
        allow_employee_swap: false,
        auto_notification: true,
        min_gap_between_shifts_hours: 11,  // Phase 1: Anti-clopening policy
    });
    if (companyError) { console.error('Error upserting company:', companyError); return; }

    // ── 1. Employees ──────────────────────────────────────────────────────────
    //
    // Realistic availability profile:
    //   Manager       → Flexible (all week, can work any time)
    //   Waiter 1–3    → Morning workers (weekdays only, 09:00–17:00)
    //   Waiter 4–5    → Evening workers (weekdays + weekend, 14:00–24:00)
    //   Cook 1–3      → Morning workers (weekdays only)
    //   Cook 4–5      → Flexible (all week)
    //
    const employeeDefinitions = [
        { name: 'Manager Sofía', role: 'manager', months: 72, availType: 'full' },

        { name: 'Camarero Pablo', role: 'waiter', months: 30, availType: 'morning' },
        { name: 'Camarera Laura', role: 'waiter', months: 24, availType: 'morning' },
        { name: 'Camarero Marcos', role: 'waiter', months: 18, availType: 'morning' },
        { name: 'Camarera Elena', role: 'waiter', months: 12, availType: 'evening' },
        { name: 'Camarero Diego', role: 'waiter', months: 6, availType: 'evening' },

        { name: 'Cocinero Carlos', role: 'cook', months: 60, availType: 'morning' },
        { name: 'Cocinera María', role: 'cook', months: 48, availType: 'morning' },
        { name: 'Cocinero Javier', role: 'cook', months: 36, availType: 'morning' },
        { name: 'Cocinera Andrea', role: 'cook', months: 20, availType: 'full' },
        { name: 'Cocinero Luis', role: 'cook', months: 8, availType: 'full' },
    ];

    const employees = employeeDefinitions.map((def, i) => ({
        id: uuidv4(),
        company_id: COMPANY_ID,
        name: def.name,
        phone_number: `+34600${String(i).padStart(6, '0')}`,
        role: def.role,
        experience_months: def.months,
        hire_date: '2022-01-01',
        _availType: def.availType, // private field for seeding logic, not sent to DB
    }));

    // Clean slate before inserting
    await supabase.from('employee_availability').delete().in('employee_id',
        (await supabase.from('employees').select('id').eq('company_id', COMPANY_ID)).data?.map(e => e.id) ?? []
    );
    await supabase.from('employees').delete().eq('company_id', COMPANY_ID);

    console.log(`Inserting ${employees.length} employees...`);
    const dbEmployees = employees.map(({ _availType, ...e }) => e);
    const { error: empError } = await supabase.from('employees').insert(dbEmployees);
    if (empError) { console.error('Error inserting employees:', empError); return; }

    // ── 2. Skills ─────────────────────────────────────────────────────────────
    console.log('Upserting skills...');
    const skillNames = ['manager', 'waiter', 'cook'];
    const skills = skillNames.map(name => ({ id: uuidv4(), name }));
    await supabase.from('skills').upsert(skills, { onConflict: 'name' });

    const { data: dbSkills } = await supabase.from('skills').select('*').in('name', skillNames);
    const companySkills = dbSkills.map(s => ({ id: uuidv4(), company_id: COMPANY_ID, skill_id: s.id }));
    await supabase.from('company_skills').upsert(companySkills, { onConflict: 'company_id, skill_id' });

    const { data: dbCompanySkills } = await supabase.from('company_skills').select('id, skill_id').eq('company_id', COMPANY_ID);
    const skillNameToId = {};
    for (const dbSkill of dbSkills) {
        const cs = dbCompanySkills.find(cs => cs.skill_id === dbSkill.id);
        if (cs) skillNameToId[dbSkill.name] = cs.id;
    }

    // ── 3. Employee Skills ────────────────────────────────────────────────────
    console.log('Linking employees to their skills...');
    const employeeSkillsList = employees.map(emp => ({
        employee_id: emp.id,
        company_skill_id: skillNameToId[emp.role],
        level: emp.experience_months >= 48 ? 'expert' : emp.experience_months >= 24 ? 'intermediate' : 'beginner',
    }));
    await supabase.from('employee_skills').delete().in('employee_id', employees.map(e => e.id));
    const { error: esError } = await supabase.from('employee_skills').insert(employeeSkillsList);
    if (esError) { console.error('Error inserting employee_skills:', esError); return; }

    // ── 4. Employee Availability (Phase 1) ────────────────────────────────────
    console.log('Inserting employee availability windows...');
    const availabilityRows = [];
    for (const emp of employees) {
        const rows =
            emp._availType === 'morning' ? weekdayAvailability(emp.id) :
                emp._availType === 'evening' ? eveningAvailability(emp.id) :
                    fullWeekAvailability(emp.id);
        availabilityRows.push(...rows);
    }
    const { error: availError } = await supabase.from('employee_availability').insert(availabilityRows);
    if (availError) { console.error('Error inserting availability:', availError); return; }

    // ── 5. Employee Preferences (Phase 1 Soft Constraints) ───────────────────
    console.log('Inserting employee preferences...');

    // preference_type must match our CHECK constraint ENUM
    const preferenceRows = [
        // Manager: no preference (works whenever needed)

        // Morning waiters prefer mornings
        { id: uuidv4(), employee_id: employees[1].id, preference_type: 'PREFERS_MORNING', weight: 4 },
        { id: uuidv4(), employee_id: employees[2].id, preference_type: 'PREFERS_MORNING', weight: 3 },
        { id: uuidv4(), employee_id: employees[3].id, preference_type: 'PREFERS_MORNING', weight: 2 },
        { id: uuidv4(), employee_id: employees[3].id, preference_type: 'AVOID_WEEKENDS', weight: 2 },

        // Evening waiters prefer evenings
        { id: uuidv4(), employee_id: employees[4].id, preference_type: 'PREFERS_EVENING', weight: 4 },
        { id: uuidv4(), employee_id: employees[5].id, preference_type: 'PREFERS_EVENING', weight: 3 },
        { id: uuidv4(), employee_id: employees[5].id, preference_type: 'PREFERS_WEEKENDS', weight: 2 },

        // Morning cooks
        { id: uuidv4(), employee_id: employees[6].id, preference_type: 'PREFERS_MORNING', weight: 5 },
        { id: uuidv4(), employee_id: employees[7].id, preference_type: 'PREFERS_MORNING', weight: 4 },
        { id: uuidv4(), employee_id: employees[8].id, preference_type: 'PREFERS_MORNING', weight: 3 },
        { id: uuidv4(), employee_id: employees[8].id, preference_type: 'AVOID_WEEKENDS', weight: 3 },

        // Flexible cooks — no strong preference
    ];

    const { error: prefError } = await supabase.from('employee_preferences').insert(preferenceRows);
    if (prefError) { console.error('Error inserting preferences:', prefError); return; }

    // ── 6. Shifts for the Week ────────────────────────────────────────────────
    console.log('Generating shifts for the week...');
    const shifts = [];

    // Two 8-hour shifts per day × 7 days. Shifts stay within the legal limits:
    //   Morning:  08:00–16:00
    //   Evening:  16:00–24:00 (midnight)
    // Each shift requires 1 manager, 2 cooks, and 3 waiters → 6 slot-tickets per shift.
    for (let day = 0; day < 7; day++) {
        const currentDate = new Date(WEEK_START);
        currentDate.setDate(currentDate.getDate() + day);
        const dateString = currentDate.toISOString().split('T')[0];

        const morningStart = new Date(`${dateString}T08:00:00Z`);
        const morningEnd = new Date(`${dateString}T16:00:00Z`);
        const eveningStart = new Date(`${dateString}T16:00:00Z`);
        const eveningEnd = new Date(eveningStart.getTime() + 8 * 60 * 60 * 1000);

        const slotTemplates = [
            // Morning slots
            { start: morningStart, end: morningEnd, role: 'manager', demand: 1.5, undesirable: 1.0 },
            { start: morningStart, end: morningEnd, role: 'cook', demand: 2.0, undesirable: 1.0 },
            { start: morningStart, end: morningEnd, role: 'cook', demand: 2.0, undesirable: 1.0 },
            { start: morningStart, end: morningEnd, role: 'waiter', demand: 3.0, undesirable: 1.0 },
            { start: morningStart, end: morningEnd, role: 'waiter', demand: 3.0, undesirable: 1.0 },
            { start: morningStart, end: morningEnd, role: 'waiter', demand: 2.5, undesirable: 1.0 },

            // Evening slots (higher undesirable weight = less desirable)
            { start: eveningStart, end: eveningEnd, role: 'manager', demand: 1.8, undesirable: 1.5 },
            { start: eveningStart, end: eveningEnd, role: 'cook', demand: 2.5, undesirable: 1.5 },
            { start: eveningStart, end: eveningEnd, role: 'cook', demand: 2.5, undesirable: 1.5 },
            { start: eveningStart, end: eveningEnd, role: 'waiter', demand: 3.5, undesirable: 1.5 },
            { start: eveningStart, end: eveningEnd, role: 'waiter', demand: 3.5, undesirable: 1.5 },
            { start: eveningStart, end: eveningEnd, role: 'waiter', demand: 3.0, undesirable: 1.5 },
        ];

        for (const t of slotTemplates) {
            shifts.push({
                id: uuidv4(),
                company_id: COMPANY_ID,
                start_time: t.start.toISOString(),
                end_time: t.end.toISOString(),
                required_skill_id: skillNameToId[t.role],
                demand_score: t.demand,
                undesirable_weight: t.undesirable,
            });
        }
    }

    console.log(`Inserting ${shifts.length} shift slots for the week...`);
    await supabase.from('shift_assignments').delete().in('shift_id',
        (await supabase.from('shifts').select('id').eq('company_id', COMPANY_ID)).data?.map(s => s.id) ?? []
    );
    await supabase.from('shifts').delete().eq('company_id', COMPANY_ID);
    const { error: shiftError } = await supabase.from('shifts').insert(shifts);
    if (shiftError) { console.error('Error inserting shifts:', shiftError); return; }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n✅ Seeding Complete! (Phase 1 — Availability + Preferences)\n');
    console.log(`  👥  ${employees.length} Employees (1 Manager, 5 Waiters, 5 Cooks)`);
    console.log(`  📅  ${availabilityRows.length} Availability windows inserted`);
    console.log(`       - Morning workers (Mon–Fri 09:00–17:00): 6 employees`);
    console.log(`       - Evening workers (Mon–Fri 14:00–24:00): 2 employees`);
    console.log(`       - Flexible (full week):                   3 employees`);
    console.log(`  ❤️   ${preferenceRows.length} Preference records (soft constraints)`);
    console.log(`  🗓️   ${shifts.length} Shift slots (2 shifts × 6 roles × 7 days)\n`);
    console.log(`  → Go to the Frontend and click "Auto Fill" to test the scheduler!`);
    console.log(`  → Morning workers should be assigned to morning shifts preferentially.`);
    console.log(`  → Evening workers should fill evening slots.`);
    console.log(`  → The 11h gap and 8h/day/40h/week caps are enforced automatically.\n`);
}

seedData().catch(console.error);
