/**
 * seed-fresh.js — Seed post-rework (Day 13 del plan)
 *
 * Siembra una empresa mínima para probar el flujo completo del modelo nuevo
 * (templates → slots virtuales → memberships → assignments). No toca la tabla
 * `shifts` (ya eliminada). No inserta `shift_assignments`: se generan al
 * invocar el comando GenerateHybridSchedule.
 *
 * Uso:
 *   SUPABASE_URL=http://localhost:54321 \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/seed-fresh.js
 *
 * Supuesto: las migraciones 20260414000000 y 20260414000001 ya se aplicaron
 * (purga + rework de schema). El script asume tablas vacías para la empresa.
 */
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'REDACTED_SUPABASE_SECRET';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// IDs estables para poder re-ejecutar sin duplicar
const COMPANY_ID = '11111111-2222-3333-4444-555555555555';
const BRANCH_ID = '11111111-2222-3333-4444-666666666666';
const DEPT_SALA_ID = '11111111-2222-3333-4444-777777777777';

const TEMPLATE_DIURNO_ID = 'a1111111-2222-3333-4444-aaaaaaaaa001';
const TEMPLATE_NOCTURNO_ID = 'a1111111-2222-3333-4444-aaaaaaaaa002';

// 5 empleados con IDs estables para facilitar debugging manual
const EMP_SOFIA = '11111111-aaaa-bbbb-cccc-000000000001'; // manager
const EMP_PABLO = '11111111-aaaa-bbbb-cccc-000000000002';
const EMP_ELENA = '11111111-aaaa-bbbb-cccc-000000000003';
const EMP_LUIS = '11111111-aaaa-bbbb-cccc-000000000004';
const EMP_ANA = '11111111-aaaa-bbbb-cccc-000000000005';

// 11 empleados extra (ids 006..016) — sin membership específica: se suman a
// AMBOS templates para que el LLM los distribuya libremente.
const EXTRA_EMPLOYEES = [
  { name: 'Carlos',   experience_months: 48, hire_date: '2022-03-01' },
  { name: 'María',    experience_months: 36, hire_date: '2023-02-01' },
  { name: 'Diego',    experience_months: 24, hire_date: '2023-09-01' },
  { name: 'Laura',    experience_months: 18, hire_date: '2024-02-01' },
  { name: 'Javier',   experience_months: 12, hire_date: '2024-07-01' },
  { name: 'Marta',    experience_months: 10, hire_date: '2024-09-01' },
  { name: 'Andrés',   experience_months: 6,  hire_date: '2025-01-01' },
  { name: 'Lucía',    experience_months: 5,  hire_date: '2025-02-01' },
  { name: 'Raúl',     experience_months: 4,  hire_date: '2025-03-01' },
  { name: 'Beatriz',  experience_months: 3,  hire_date: '2025-04-01' },
  { name: 'Fernando', experience_months: 2,  hire_date: '2025-05-01' },
].map((e, i) => ({
  ...e,
  id: `11111111-aaaa-bbbb-cccc-${String(6 + i).padStart(12, '0')}`,
  phone_number: `+1202555${String(105 + i).padStart(4, '0')}`,
}));

function upcomingMondayISO() {
  const d = new Date();
  const dow = d.getUTCDay();
  const daysUntilMonday = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().split('T')[0];
}

async function die(msg, err) {
  console.error(`❌ ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

async function main() {
  console.log('🌱 Seeding fresh data (post-rework schema)');

  // 1. Company
  {
    const { error } = await supabase.from('companies').upsert({
      id: COMPANY_ID,
      name: 'Restaurante Rework Demo',
      allow_employee_swap: true,
      auto_notification: true,
    });
    if (error) return die('Upsert companies failed', error);
  }

  // 2. Branch + Department
  {
    const { error } = await supabase.from('branches').upsert({
      id: BRANCH_ID,
      company_id: COMPANY_ID,
      name: 'Sucursal Central',
      timezone: 'CET',
    });
    if (error) return die('Upsert branches failed', error);
  }
  {
    const { error } = await supabase.from('departments').upsert({
      id: DEPT_SALA_ID,
      branch_id: BRANCH_ID,
      company_id: COMPANY_ID,
      name: 'Sala',
    });
    if (error) return die('Upsert departments failed', error);
  }

  // 3. Shift templates
  //   - Diurno (todos los días, obligatorio cap=2)
  //   - Nocturno (todos los días, opcional — required_employees=NULL)
  {
    const { error } = await supabase.from('shift_templates').upsert([
      {
        id: TEMPLATE_DIURNO_ID,
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Turno Diurno',
        day_of_week: null, // aplica todos los días
        start_time: '08:00',
        end_time: '16:00',
        demand_score: 5.0,
        undesirable_weight: 0.2,
        required_employees: 2,
        is_active: true,
      },
      {
        id: TEMPLATE_NOCTURNO_ID,
        company_id: COMPANY_ID,
        department_id: DEPT_SALA_ID,
        name: 'Turno Nocturno',
        day_of_week: null,
        start_time: '22:00',
        end_time: '06:00', // cruza medianoche
        demand_score: 3.0,
        undesirable_weight: 0.8,
        required_employees: null, // OPCIONAL: no se fuerza cobertura
        is_active: true,
      },
    ]);
    if (error) return die('Upsert shift_templates failed', error);
  }

  // 4. Employees (purga sólo los de esta empresa para re-ejecutar)
  await supabase.from('employees').delete().eq('company_id', COMPANY_ID);

  const employees = [
    {
      id: EMP_SOFIA,
      company_id: COMPANY_ID,
      department_id: DEPT_SALA_ID,
      name: 'Sofía (Manager)',
      phone_number: '+15551234567',
      role: 'manager',
      experience_months: 72,
      hire_date: '2022-01-01',
    },
    {
      id: EMP_PABLO,
      company_id: COMPANY_ID,
      department_id: DEPT_SALA_ID,
      name: 'Pablo',
      phone_number: '+12025550101',
      role: 'employee',
      experience_months: 30,
      hire_date: '2023-01-01',
    },
    {
      id: EMP_ELENA,
      company_id: COMPANY_ID,
      department_id: DEPT_SALA_ID,
      name: 'Elena',
      phone_number: '+15616954782',
      role: 'employee',
      experience_months: 20,
      hire_date: '2023-06-01',
    },
    {
      id: EMP_LUIS,
      company_id: COMPANY_ID,
      department_id: DEPT_SALA_ID,
      name: 'Luis',
      phone_number: '+12025550103',
      role: 'employee',
      experience_months: 14,
      hire_date: '2024-01-01',
    },
    {
      id: EMP_ANA,
      company_id: COMPANY_ID,
      department_id: DEPT_SALA_ID,
      name: 'Ana',
      phone_number: '+12025550104',
      role: 'employee',
      experience_months: 8,
      hire_date: '2024-06-01',
    },
    ...EXTRA_EMPLOYEES.map((e) => ({
      id: e.id,
      company_id: COMPANY_ID,
      department_id: DEPT_SALA_ID,
      name: e.name,
      phone_number: e.phone_number,
      role: 'employee',
      experience_months: e.experience_months,
      hire_date: e.hire_date,
    })),
  ];

  {
    const { error } = await supabase.from('employees').insert(employees);
    if (error) return die('Insert employees failed', error);
  }

  // 5. Shift memberships (core del modelo nuevo)
  //   - Sofía, Pablo, Ana, Elena → Diurno (manager + 3 camareros)
  //   - Luis, Elena → Nocturno (Elena hace doble servicio; en la práctica
  //     sus turnos se distribuirán por semana, no habrá doble turno el mismo
  //     día salvo que una regla explícita lo permita)
  const effectiveFrom = '2024-01-01';
  await supabase.from('shift_memberships').delete().eq('company_id', COMPANY_ID);
  {
    const memberships = [
      { company_id: COMPANY_ID, employee_id: EMP_SOFIA, template_id: TEMPLATE_DIURNO_ID, effective_from: effectiveFrom },
      { company_id: COMPANY_ID, employee_id: EMP_PABLO, template_id: TEMPLATE_DIURNO_ID, effective_from: effectiveFrom },
      { company_id: COMPANY_ID, employee_id: EMP_ANA,   template_id: TEMPLATE_DIURNO_ID, effective_from: effectiveFrom },
      { company_id: COMPANY_ID, employee_id: EMP_ELENA, template_id: TEMPLATE_DIURNO_ID, effective_from: effectiveFrom },
      { company_id: COMPANY_ID, employee_id: EMP_LUIS,  template_id: TEMPLATE_NOCTURNO_ID, effective_from: effectiveFrom },
      { company_id: COMPANY_ID, employee_id: EMP_ELENA, template_id: TEMPLATE_NOCTURNO_ID, effective_from: effectiveFrom },
      // Los 11 extra reciben ambos templates: el LLM decide a quién asigna dónde.
      ...EXTRA_EMPLOYEES.flatMap((e) => [
        { company_id: COMPANY_ID, employee_id: e.id, template_id: TEMPLATE_DIURNO_ID,   effective_from: effectiveFrom },
        { company_id: COMPANY_ID, employee_id: e.id, template_id: TEMPLATE_NOCTURNO_ID, effective_from: effectiveFrom },
      ]),
    ];
    const { error } = await supabase.from('shift_memberships').insert(memberships);
    if (error) return die('Insert shift_memberships failed', error);
  }

  // 6. Limpiar assignments residuales (quedarían huérfanos de runs previos)
  await supabase.from('shift_assignments').delete().eq('company_id', COMPANY_ID);

  const monday = upcomingMondayISO();

  console.log('');
  console.log('✅ Seed completo');
  console.log('---------------------------------------------------------------');
  console.log(`Compañía    : ${COMPANY_ID}`);
  console.log(`Templates   : Diurno (cap=2, obligatorio) + Nocturno (cap=null, opcional)`);
  console.log(`Empleados   : ${employees.length}`);
  console.log(`  - Sofía (manager)  ${employees[0].phone_number}`);
  console.log(`  - Pablo            ${employees[1].phone_number}`);
  console.log(`  - Elena            ${employees[2].phone_number}  (Diurno + Nocturno)`);
  console.log(`  - Luis             ${employees[3].phone_number}  (Nocturno)`);
  console.log(`  - Ana              ${employees[4].phone_number}`);
  for (const e of EXTRA_EMPLOYEES) {
    const pad = e.name.padEnd(16, ' ');
    console.log(`  - ${pad} ${e.phone_number}  (Diurno + Nocturno)`);
  }
  const diurnoCount = 4 + EXTRA_EMPLOYEES.length;   // Sofía, Pablo, Ana, Elena + extras
  const nocturnoCount = 2 + EXTRA_EMPLOYEES.length; // Luis, Elena + extras
  console.log(
    `Memberships : ${diurnoCount + nocturnoCount} filas (${diurnoCount} en Diurno, ${nocturnoCount} en Nocturno)`,
  );
  console.log('---------------------------------------------------------------');
  console.log(`Semana a generar : ${monday} (próximo lunes)`);
  console.log('');
  console.log('Para generar el horario:');
  console.log(`  Via WhatsApp (Sofía): "genera el horario de la semana ${monday}"`);
  console.log(`  Via API            : POST /schedule/generate-hybrid  { companyId, weekStart: "${monday}" }`);
  console.log('---------------------------------------------------------------');
}

main().catch((err) => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
