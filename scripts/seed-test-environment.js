/**
 * seed-test-environment.js
 *
 * WIPE + SEED: estado limpio para pruebas WhatsApp del manager.
 *
 * Estructura objetivo:
 *   1 company   "Demo Co"
 *   1 branch    "Sucursal Central"
 *   2 deptos    "Retail" + "Seguridad"
 *   1 manager   +15616954782   (sin departamento, role=manager)
 *  20 empleados (10 por departamento)
 *     Retail:    Pablo, Elena, Luis, Ana, Carlos, María, Diego, Laura, Javier, Marta
 *     Seguridad: Andrés, Beatriz, Fernando, Lucía, Raúl, Marcos, Patricia, Julián, Isabel, Héctor
 *   4 shift_templates
 *     Retail   Diurno    07:00 - 15:00
 *     Retail   Tarde     11:00 - 19:00
 *     Retail   Nocturno  15:00 - 23:00
 *     Seguridad 24h      08:00 - 08:00  (cruza medianoche)
 *
 * NO crea policies ni rules — las crea el manager via WhatsApp.
 *
 * Uso:
 *   node scripts/seed-test-environment.js
 *
 * Asume Supabase local corriendo en localhost:54322 (Postgres directo).
 */
const { Client } = require('pg');

// Local Supabase por default; override con DATABASE_URL para sembrar
// staging/prod (ej. Session Pooler de Supabase Cloud).
const PG_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:54322/postgres';

// IDs estables (re-ejecutable). Forma UUID, no requiere ser RFC 4122 estricto.
const COMPANY_ID    = '22222222-2222-3333-4444-555555555555';
const BRANCH_ID     = '22222222-2222-3333-4444-666666666666';
const DEPT_RETAIL   = '22222222-2222-3333-4444-777777777701';
const DEPT_SEGURIDAD = '22222222-2222-3333-4444-777777777702';

const T_DIURNO    = 'a2222222-2222-3333-4444-aaaaaaaaa001';
const T_TARDE     = 'a2222222-2222-3333-4444-aaaaaaaaa002';
const T_NOCTURNO  = 'a2222222-2222-3333-4444-aaaaaaaaa003';
const T_24H       = 'a2222222-2222-3333-4444-bbbbbbbbb001';

const MGR_ID = 'e2222222-aaaa-bbbb-cccc-000000000001';

const RETAIL_EMPLOYEES = [
  { id: 'e2222222-aaaa-bbbb-cccc-000000000002', name: 'Pablo',  phone: '+15616950001', exp: 36 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000003', name: 'Elena',  phone: '+15616950002', exp: 30 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000004', name: 'Luis',   phone: '+15616950003', exp: 24 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000005', name: 'Ana',    phone: '+15616950004', exp: 20 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000006', name: 'Carlos', phone: '+15616950005', exp: 14 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000007', name: 'María',  phone: '+15616950006', exp: 10 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000008', name: 'Diego',  phone: '+15616950007', exp: 8  },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000009', name: 'Laura',  phone: '+15616950008', exp: 18 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000010', name: 'Javier', phone: '+15616950009', exp: 12 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000011', name: 'Marta',  phone: '+15616950010', exp: 6  },
];

const SECURITY_EMPLOYEES = [
  { id: 'e2222222-aaaa-bbbb-cccc-000000000012', name: 'Andrés',   phone: '+15616950011', exp: 72 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000013', name: 'Beatriz',  phone: '+15616950012', exp: 60 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000014', name: 'Fernando', phone: '+15616950013', exp: 48 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000015', name: 'Lucía',    phone: '+15616950014', exp: 40 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000016', name: 'Raúl',     phone: '+15616950015', exp: 36 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000017', name: 'Marcos',   phone: '+15616950016', exp: 30 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000018', name: 'Patricia', phone: '+15616950017', exp: 24 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000019', name: 'Julián',   phone: '+15616950018', exp: 18 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000020', name: 'Isabel',   phone: '+15616950019', exp: 12 },
  { id: 'e2222222-aaaa-bbbb-cccc-000000000021', name: 'Héctor',   phone: '+15616950020', exp: 8  },
];

async function main() {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  console.log('🔌 Connected to local Postgres');

  try {
    await client.query('BEGIN');

    // 1) WIPE — borra todas las companies; CASCADE tira al resto.
    console.log('🧹 Wiping existing data (DELETE FROM companies CASCADE)...');
    await client.query('DELETE FROM companies');

    // Por seguridad, limpiar también lo que NO esté ligado a company por FK.
    // skills es global → respetar. whatsapp_handshakes, semantic_rules,
    // shift_swap_requests, absence_reports, day_off_requests, incidents,
    // company_policies, shift_memberships, shift_assignments, fairness_history
    // todos referencian company_id con CASCADE, así que ya quedaron limpios.

    // 2) Company
    console.log('🏢 Inserting company...');
    await client.query(
      `INSERT INTO companies (id, name, allow_employee_swap, auto_notification, whatsapp_policy_creator_roles)
       VALUES ($1, $2, true, true, ARRAY['manager'])`,
      [COMPANY_ID, 'Demo Co'],
    );

    // 3) Branch
    console.log('🏬 Inserting branch...');
    await client.query(
      `INSERT INTO branches (id, company_id, name, timezone)
       VALUES ($1, $2, $3, $4)`,
      [BRANCH_ID, COMPANY_ID, 'Sucursal Central', 'America/New_York'],
    );

    // 4) Departments
    console.log('🏷️  Inserting departments (Retail, Seguridad)...');
    await client.query(
      `INSERT INTO departments (id, branch_id, company_id, name) VALUES
        ($1, $2, $3, 'Retail'),
        ($4, $5, $6, 'Seguridad')`,
      [DEPT_RETAIL, BRANCH_ID, COMPANY_ID, DEPT_SEGURIDAD, BRANCH_ID, COMPANY_ID],
    );

    // 5) Shift templates
    //    - Retail: Diurno 07-15, Tarde 11-19, Nocturno 15-23.
    //    - Seguridad: 24h (08:00 → 08:00 next day).
    console.log('⏰ Inserting shift templates (3 retail + 1 seguridad)...');
    await client.query(
      `INSERT INTO shift_templates
        (id, company_id, department_id, name, day_of_week, start_time, end_time,
         demand_score, undesirable_weight, required_employees, is_active)
       VALUES
        ($1, $2, $3, 'Retail Diurno',    NULL, '07:00', '15:00', 5.0, 0.2, NULL, true),
        ($4, $5, $6, 'Retail Tarde',     NULL, '11:00', '19:00', 4.5, 0.3, NULL, true),
        ($7, $8, $9, 'Retail Nocturno',  NULL, '15:00', '23:00', 4.0, 0.5, NULL, true),
        ($10,$11,$12,'Seguridad 24h',     NULL, '08:00', '08:00', 6.0, 0.9, 2, true)`,
      [
        T_DIURNO,   COMPANY_ID, DEPT_RETAIL,
        T_TARDE,    COMPANY_ID, DEPT_RETAIL,
        T_NOCTURNO, COMPANY_ID, DEPT_RETAIL,
        T_24H,      COMPANY_ID, DEPT_SEGURIDAD,
      ],
    );

    // 6) Manager — sin department (transversal)
    console.log('👤 Inserting manager (+15616954782)...');
    await client.query(
      `INSERT INTO employees
        (id, company_id, department_id, name, phone_number, role,
         experience_months, hire_date, whatsapp_verified, status)
       VALUES ($1, $2, NULL, 'Marco (Manager)', '+15616954782', 'manager',
               120, '2020-01-01', true, 'active')`,
      [MGR_ID, COMPANY_ID],
    );

    // 7) Retail employees
    console.log(`🛍️  Inserting ${RETAIL_EMPLOYEES.length} Retail employees...`);
    for (const e of RETAIL_EMPLOYEES) {
      await client.query(
        `INSERT INTO employees
          (id, company_id, department_id, name, phone_number, role,
           experience_months, hire_date, whatsapp_verified, status)
         VALUES ($1, $2, $3, $4, $5, 'employee', $6, '2024-01-01', false, 'active')`,
        [e.id, COMPANY_ID, DEPT_RETAIL, e.name, e.phone, e.exp],
      );
    }

    // 8) Security employees
    console.log(`🛡️  Inserting ${SECURITY_EMPLOYEES.length} Seguridad employees...`);
    for (const e of SECURITY_EMPLOYEES) {
      await client.query(
        `INSERT INTO employees
          (id, company_id, department_id, name, phone_number, role,
           experience_months, hire_date, whatsapp_verified, status)
         VALUES ($1, $2, $3, $4, $5, 'employee', $6, '2023-01-01', false, 'active')`,
        [e.id, COMPANY_ID, DEPT_SEGURIDAD, e.name, e.phone, e.exp],
      );
    }

    // 9) Memberships — todos los de Seguridad anclados al template 24h.
    //    Retail no se ancla: el LLM distribuye entre Diurno/Tarde/Nocturno.
    console.log(`🔗 Inserting memberships (Seguridad → 24h)...`);
    for (const e of SECURITY_EMPLOYEES) {
      await client.query(
        `INSERT INTO shift_memberships
          (company_id, employee_id, template_id, effective_from, effective_until)
         VALUES ($1, $2, $3, '2024-01-01', NULL)`,
        [COMPANY_ID, e.id, T_24H],
      );
    }

    await client.query('COMMIT');
    console.log('✅ Commit OK');

    // Smoke check
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM companies)        AS companies,
        (SELECT count(*) FROM branches)         AS branches,
        (SELECT count(*) FROM departments)      AS departments,
        (SELECT count(*) FROM shift_templates)  AS templates,
        (SELECT count(*) FROM employees)        AS employees,
        (SELECT count(*) FROM employees WHERE role='manager') AS managers,
        (SELECT count(*) FROM employees WHERE department_id=$1) AS retail_count,
        (SELECT count(*) FROM employees WHERE department_id=$2) AS seguridad_count,
        (SELECT count(*) FROM shift_memberships WHERE template_id=$3) AS seguridad_memberships
    `, [DEPT_RETAIL, DEPT_SEGURIDAD, T_24H]);

    console.log('');
    console.log('📊 Resultado:');
    console.table(counts.rows[0]);

    console.log('');
    console.log('🔑 Datos clave para WhatsApp / API:');
    console.log(`   companyId      : ${COMPANY_ID}`);
    console.log(`   manager phone  : +15616954782`);
    console.log(`   Retail dept    : ${DEPT_RETAIL}`);
    console.log(`   Seguridad dept : ${DEPT_SEGURIDAD}`);
    console.log(`   Templates      : Diurno (07-15), Tarde (11-19), Nocturno (15-23), Seguridad 24h (08-08)`);
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Falló el seed, rollback ejecutado:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
