const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'REDACTED_SUPABASE_SECRET';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const COMPANY_ID = '11111111-2222-3333-4444-555555555555';
const BRANCH_ID = '11111111-2222-3333-4444-666666666666';
const DEPT_SALA_ID = '11111111-2222-3333-4444-777777777777';
const DEPT_COCINA_ID = '11111111-2222-3333-4444-888888888888';

const TEMPLATE_MORNING_ID = 'T1111111-2222-3333-4444-M0RN1NG00000';
const TEMPLATE_EVENING_ID = 'T1111111-2222-3333-4444-EV3N1NG00000';

const WEEK_START = '2026-03-23'; // Monday

async function seedV2Data() {
    console.log('🌱 Starting V2 SaaS Enterprise Architecture Data Seeding...');

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

    // 3. Shift Templates
    console.log('Inserting Shift Templates...');
    await supabase.from('shift_templates').upsert([
        { id: TEMPLATE_MORNING_ID, department_id: DEPT_SALA_ID, name: 'Turno Diurno', time_start: '08:00', time_end: '16:00', is_active: true },
        { id: TEMPLATE_EVENING_ID, department_id: DEPT_SALA_ID, name: 'Turno Nocturno', time_start: '16:00', time_end: '23:59', is_active: true }
    ]);

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

    // Use specific Twilio mock numbers or the test number +15551234567 
    // And +12025550101 (requester) and +15616954782 (target tests)
    const empMe = {
        id: uuidv4(),
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID, // V2 linking
        name: 'Manager Sofía (Tú)',
        phone_number: '+15551234567', // Twilio Test Number from scenarios
        role: 'manager',
        experience_months: 72,
        hire_date: '2022-01-01',
    };

    const empTarget = {
        id: uuidv4(),
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Camarero Pablo',
        phone_number: '+12025550101', // Target 1
        role: 'waiter',
        experience_months: 30,
        hire_date: '2022-01-01',
    };

    const empTarget2 = {
        id: uuidv4(),
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Camarera Elena',
        phone_number: '+15616954782', // Target 2
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

    // 5. Instantiating Shifts & Assignments for Sunday (Week End)
    // To test swaps, they must have assignments
    console.log('Generating Shifts and Assignments for Sunday...');
    const targetDate = '2026-03-29'; // Sunday of WEEK_START=2026-03-23
    
    // Create 1 Morning Shift Block from Template
    const shift1Id = uuidv4();
    await supabase.from('shifts').insert({
        id: shift1Id,
        company_id: COMPANY_ID,
        shift_template_id: TEMPLATE_MORNING_ID, // V2 linking
        start_time: `${targetDate}T08:00:00Z`,
        end_time: `${targetDate}T16:00:00Z`,
        required_skill_id: csManager, // Just an example
        demand_score: 5,
        undesirable_weight: 1
    });

    // Create 1 Evening Shift Block from Template
    const shift2Id = uuidv4();
    await supabase.from('shifts').insert({
        id: shift2Id,
        company_id: COMPANY_ID,
        shift_template_id: TEMPLATE_EVENING_ID, // V2 linking
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
            employee_id: empMe.id, // I have the morning shift
            assigned_by_strategy: 'manual'
            // actual_start_time / actual_end_time are not strictly required unless partial
        },
        {
            company_id: COMPANY_ID,
            shift_id: shift1Id,
            employee_id: empTarget.id, // Pablo is ALSO assigned to morning shift (just to prove grouping in WhatsApp)
            assigned_by_strategy: 'manual'
        },
        {
            company_id: COMPANY_ID,
            shift_id: shift2Id,
            employee_id: empTarget2.id, // Elena is on evening shift
            assigned_by_strategy: 'manual'
        }
    ]);

    // Summary
    console.log('');
    console.log('✅ Seeding Complete! (V2 Architecture for Swap Testing)');
    console.log('---------------------------------------------------------');
    console.log('Your WhatsApp Test Context:');
    console.log(`Tu eres: ${empMe.name} (${empMe.phone_number})`);
    console.log(`Tienes asignado un turno el domingo: Turno Diurno (08:00-16:00)`);
    console.log('Opciones de Swap (WhatsApp agrupará estos por Turno Diurno/Nocturno):');
    console.log(' - ' + empTarget.name + ' tiene un Turno Diurno el mismo día');
    console.log(' - ' + empTarget2.name + ' tiene un Turno Nocturno el mismo día');
    console.log('---------------------------------------------------------');
}

seedV2Data().catch(console.error);
