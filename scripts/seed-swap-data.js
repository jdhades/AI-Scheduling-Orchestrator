require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'REDACTED_SUPABASE_SECRET';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const COMPANY_ID = '11111111-2222-3333-4444-555555555555';

async function seed() {
    const { data: employees, error: empError } = await supabase.from('employees').select('id, name, phone_number').eq('company_id', COMPANY_ID);
    if (empError) { console.error(empError); return; }

    // Our Twilio trial test sandbox phone number
    const testUser = employees.find(e => e.phone_number === '+15616954782');
    if (!testUser) {
        console.error("Test user +15616954782 not found! Make sure you seeded the company.");
        return;
    }
    const colleague = employees.find(e => e.id !== testUser.id);

    console.log(`Found test user: ${testUser.name} (${testUser.phone_number})`);
    console.log(`Found colleague: ${colleague.name}`);

    const now = new Date();
    
    function createDate(daysOffset, hours) {
        const d = new Date(now);
        d.setDate(d.getDate() + daysOffset);
        d.setHours(hours, 0, 0, 0);
        return d;
    }

    // Create 3 shifts for the current week to test the flow
    const shift1Start = createDate(1, 8); // Tomorrow 8am
    const shift1End = createDate(1, 16);
    
    const shift2Start = createDate(2, 12); // Day after tomorrow 12pm
    const shift2End = createDate(2, 20);
    
    const openShiftStart = createDate(3, 10); // 3 days from now 10am
    const openShiftEnd = createDate(3, 18);

    const shift1Id = uuidv4();
    const shift2Id = uuidv4();
    const openShiftId = uuidv4();

    console.log('Inserting 3 shifts...');
    const shifts = [
        { id: shift1Id, company_id: COMPANY_ID, start_time: shift1Start.toISOString(), end_time: shift1End.toISOString(), required_skill_level: 'junior', required_experience_months: 0, demand_score: 1, undesirable_weight: 1 },
        { id: shift2Id, company_id: COMPANY_ID, start_time: shift2Start.toISOString(), end_time: shift2End.toISOString(), required_skill_level: 'junior', required_experience_months: 0, demand_score: 1, undesirable_weight: 1 },
        { id: openShiftId, company_id: COMPANY_ID, start_time: openShiftStart.toISOString(), end_time: openShiftEnd.toISOString(), required_skill_level: 'junior', required_experience_months: 0, demand_score: 1, undesirable_weight: 1 },
    ];
    const { error: sError } = await supabase.from('shifts').insert(shifts);
    if (sError) { console.error('Shift error:', sError); return; }

    console.log('Inserting 2 assignments (1 for you, 1 for colleague)...');
    
    // Test user gets tomorrow's shift
    // Colleague gets the day after tomorrow's shift
    // The 3rd shift remains OPEN (unassigned)
    const assignments = [
        { id: uuidv4(), shift_id: shift1Id, employee_id: testUser.id, company_id: COMPANY_ID, assigned_at: new Date().toISOString(), assigned_by_strategy: 'manual', fairness_snapshot: {} },
        { id: uuidv4(), shift_id: shift2Id, employee_id: colleague.id, company_id: COMPANY_ID, assigned_at: new Date().toISOString(), assigned_by_strategy: 'manual', fairness_snapshot: {} }
    ];
    const { error: aError } = await supabase.from('shift_assignments').insert(assignments);
    if (aError) { console.error('Join error:', aError); return; }

    console.log(`\n✅ Done! Now you can test on WhatsApp!`);
    console.log(`Tu turno: ${shift1Start.toLocaleDateString()} a las ${shift1Start.getHours()}:00`);
    console.log(`Turno de ${colleague.name}: ${shift2Start.toLocaleDateString()} a las ${shift2Start.getHours()}:00`);
    console.log(`Turno Libre: ${openShiftStart.toLocaleDateString()} a las ${openShiftStart.getHours()}:00\n`);
    
    console.log(`Envía "Quiero cambiar mi turno" por WhatsApp y verás las opciones.`);
}

seed().catch(console.error);
