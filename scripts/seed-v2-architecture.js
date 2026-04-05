const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'REDACTED_SUPABASE_SECRET';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const COMPANY_ID = '11111111-2222-3333-4444-555555555555';
const BRANCH_ID = '11111111-2222-3333-4444-666666666666';
const DEPT_SALA_ID = '11111111-2222-3333-4444-777777777777';
const DEPT_COCINA_ID = '11111111-2222-3333-4444-888888888888';

const TEMPLATE_MORNING_ID = 'a1111111-2222-3333-4444-aaaaaaaaa001';
const TEMPLATE_EVENING_ID = 'a1111111-2222-3333-4444-aaaaaaaaa002';

/**
 * Returns the upcoming Monday (or today if already Monday) in YYYY-MM-DD.
 * Shifts are seeded for the upcoming week so the generate flow always has data.
 */
function getUpcomingMonday() {
    const d = new Date();
    const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : (8 - day);
    d.setDate(d.getDate() + daysUntilMonday);
    return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
}

async function seedV2Data() {
    console.log('🌱 Starting V2 SaaS Enterprise Architecture Data Seeding...');

    const WEEK_START = getUpcomingMonday();
    console.log(`📅 Target week: ${WEEK_START} (upcoming Monday)`);

    // 0. Company
    const { error: companyError } = await supabase.from('companies').upsert({
        id: COMPANY_ID,
        name: 'Restaurante Enterprise V2',
        allow_employee_swap: true,
        auto_notification: true,
        min_gap_between_shifts_hours: 11,
    });
    if (companyError) { console.error('Error upserting company:', companyError); return; }

    // 1. Branch
    console.log('Inserting Branch (Sucursal Central)...');
    await supabase.from('branches').upsert({
        id: BRANCH_ID,
        company_id: COMPANY_ID,
        name: 'Sucursal Central - Madrid',
        timezone: 'CET'
    });

    // 2. Departments
    console.log('Inserting Departments (Sala y Cocina)...');
    await supabase.from('departments').upsert([
        { id: DEPT_SALA_ID, branch_id: BRANCH_ID, company_id: COMPANY_ID, name: 'Sala' },
        { id: DEPT_COCINA_ID, branch_id: BRANCH_ID, company_id: COMPANY_ID, name: 'Cocina' }
    ]);

    // 3. Shift Templates (with ALL required fields including day_of_week)
    console.log('Inserting Shift Templates...');
    const { error: tmplError } = await supabase.from('shift_templates').upsert([
        {
            id: TEMPLATE_MORNING_ID,
            company_id: COMPANY_ID,
            department_id: DEPT_SALA_ID,
            name: 'Turno Diurno',
            day_of_week: 1, // Monday (templates are recurring; day_of_week used for instantiation)
            start_time: '08:00',
            end_time: '16:00',
            demand_score: 5.0,
            undesirable_weight: 1.0,
            is_active: true,
        },
        {
            id: TEMPLATE_EVENING_ID,
            company_id: COMPANY_ID,
            department_id: DEPT_SALA_ID,
            name: 'Turno Nocturno',
            day_of_week: 1,
            start_time: '16:00',
            end_time: '23:59',
            demand_score: 5.0,
            undesirable_weight: 1.0,
            is_active: true,
        }
    ]);
    if (tmplError) { console.error('❌ Error upserting shift_templates:', tmplError); return; }
    console.log('✅ Shift templates inserted successfully');

    // 4. Employees & Skills (Simplified subset for WhatsApp Swap Testing)
    console.log('Upserting Skills & Employees...');
    const skillManagerId = uuidv4();
    const skillWaiterId = uuidv4();
    await supabase.from('skills').upsert([{ id: skillManagerId, name: 'manager' }, { id: skillWaiterId, name: 'waiter' }], { onConflict: 'name' });
    
    const { data: dbSkills } = await supabase.from('skills').select('*').in('name', ['manager', 'waiter']);
    const mSkill = dbSkills.find(s => s.name === 'manager').id;
    const wSkill = dbSkills.find(s => s.name === 'waiter').id;

    const companySkills = [
        { id: uuidv4(), company_id: COMPANY_ID, skill_id: mSkill },
        { id: uuidv4(), company_id: COMPANY_ID, skill_id: wSkill }
    ];
    await supabase.from('company_skills').upsert(companySkills, { onConflict: 'company_id, skill_id' });

    const { data: dbCompanySkills } = await supabase.from('company_skills').select('id, skill_id').eq('company_id', COMPANY_ID);
    const csManager = dbCompanySkills.find(cs => cs.skill_id === mSkill).id;
    const csWaiter = dbCompanySkills.find(cs => cs.skill_id === wSkill).id;

    const empMe = {
        id: uuidv4(),
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Manager Sofía (Tú)',
        phone_number: '+15551234567',
        role: 'manager',
        experience_months: 72,
        hire_date: '2022-01-01',
    };

    const empTarget = {
        id: uuidv4(),
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Camarero Pablo',
        phone_number: '+12025550101',
        role: 'waiter',
        experience_months: 30,
        hire_date: '2022-01-01',
    };

    const empTarget2 = {
        id: uuidv4(),
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Camarera Elena',
        phone_number: '+15616954782',
        role: 'waiter',
        experience_months: 20,
        hire_date: '2022-01-01',
    };

    // Clean employees
    await supabase.from('employees').delete().eq('company_id', COMPANY_ID);
    await supabase.from('employees').insert([empMe, empTarget, empTarget2]);

    // Employee Skills
    await supabase.from('employee_skills').insert([
        { employee_id: empMe.id, company_skill_id: csManager, level: 'expert' },
        { employee_id: empTarget.id, company_skill_id: csWaiter, level: 'intermediate' },
        { employee_id: empTarget2.id, company_skill_id: csWaiter, level: 'intermediate' },
    ]);

    // 5. Instantiating Shifts & Assignments for the upcoming week
    // Create shifts for Wednesday of the target week (WEEK_START + 2 days)
    console.log('Generating Shifts and Assignments...');
    const targetDate = addDays(WEEK_START, 2); // Wednesday
    console.log(`📅 Shifts target date: ${targetDate} (Wednesday)`);
    
    // Clean old shifts for this company
    await supabase.from('shift_assignments').delete().eq('company_id', COMPANY_ID);
    await supabase.from('shifts').delete().eq('company_id', COMPANY_ID);

    // Create 1 Morning Shift Block from Template
    const shift1Id = uuidv4();
    await supabase.from('shifts').insert({
        id: shift1Id,
        company_id: COMPANY_ID,
        shift_template_id: TEMPLATE_MORNING_ID,
        start_time: `${targetDate}T08:00:00Z`,
        end_time: `${targetDate}T16:00:00Z`,
        required_skill_id: csManager,
        demand_score: 5,
        undesirable_weight: 1
    });

    // Create 1 Evening Shift Block from Template
    const shift2Id = uuidv4();
    await supabase.from('shifts').insert({
        id: shift2Id,
        company_id: COMPANY_ID,
        shift_template_id: TEMPLATE_EVENING_ID,
        start_time: `${targetDate}T16:00:00Z`,
        end_time: `${targetDate}T23:59:59Z`,
        required_skill_id: csWaiter,
        demand_score: 5,
        undesirable_weight: 1
    });

    // 6. Assignments
    console.log('Assigning Employees to Shifts...');
    await supabase.from('shift_assignments').insert([
        {
            company_id: COMPANY_ID,
            shift_id: shift1Id,
            employee_id: empMe.id,
            assigned_by_strategy: 'manual'
        },
        {
            company_id: COMPANY_ID,
            shift_id: shift1Id,
            employee_id: empTarget.id,
            assigned_by_strategy: 'manual'
        },
        {
            company_id: COMPANY_ID,
            shift_id: shift2Id,
            employee_id: empTarget2.id,
            assigned_by_strategy: 'manual'
        }
    ]);

    // Summary
    console.log('');
    console.log('✅ Seeding Complete! (V2 Architecture for Swap Testing)');
    console.log('---------------------------------------------------------');
    console.log('Your WhatsApp Test Context:');
    console.log(`Week: ${WEEK_START}`);
    console.log(`Shifts on: ${targetDate} (Wednesday)`);
    console.log(`Tu eres: ${empMe.name} (${empMe.phone_number})`);
    console.log(`Tienes asignado un turno: Turno Diurno (08:00-16:00)`);
    console.log('Opciones de Swap:');
    console.log(' - ' + empTarget.name + ' tiene un Turno Diurno el mismo día');
    console.log(' - ' + empTarget2.name + ' tiene un Turno Nocturno el mismo día');
    console.log('---------------------------------------------------------');
    console.log('Shift Templates (for generate flow):');
    console.log(' - Turno Diurno (08:00-16:00) — active');
    console.log(' - Turno Nocturno (16:00-23:59) — active');
    console.log('---------------------------------------------------------');
}

seedV2Data().catch(console.error);
