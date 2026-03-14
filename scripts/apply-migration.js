/**
 * apply-migration.js
 * Applies the Phase 1 migration SQL directly via pg driver.
 * The local Supabase Postgres runs on port 54322.
 */
const { Client } = require('pg');

const client = new Client({
    host: 'localhost',
    port: 54322,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
});

async function applyMigration() {
    await client.connect();
    console.log('🔧 Applying Phase 1 migration...');

    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS min_gap_between_shifts_hours INTEGER NOT NULL DEFAULT 11;`);
    console.log('✅ min_gap_between_shifts_hours column added to companies');

    await client.query(`
        CREATE TABLE IF NOT EXISTS employee_availability (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            day_of_week     INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
            start_time      TIME NOT NULL,
            end_time        TIME NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (end_time > start_time)
        );
    `);
    console.log('✅ employee_availability table created');

    await client.query(`
        CREATE TABLE IF NOT EXISTS employee_preferences (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            preference_type TEXT NOT NULL CHECK (preference_type IN ('PREFERS_MORNING','PREFERS_EVENING','PREFERS_NIGHT','AVOID_WEEKENDS','PREFERS_WEEKENDS')),
            weight          INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1 AND weight <= 5),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (employee_id, preference_type)
        );
    `);
    console.log('✅ employee_preferences table created');

    await client.query(`ALTER TABLE employee_availability ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE employee_preferences  ENABLE ROW LEVEL SECURITY;`);

    await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employee_availability' AND policyname='tenant_isolation') THEN
            CREATE POLICY tenant_isolation ON employee_availability USING (
              employee_id IN (SELECT id FROM employees WHERE company_id = current_tenant_id())
            );
          END IF;
        END $$;
    `);
    await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employee_preferences' AND policyname='tenant_isolation') THEN
            CREATE POLICY tenant_isolation ON employee_preferences USING (
              employee_id IN (SELECT id FROM employees WHERE company_id = current_tenant_id())
            );
          END IF;
        END $$;
    `);

    console.log('✅ RLS policies applied');
    await client.end();
    console.log('\n🎉 Migration complete! Run: node scripts/seed-scenario-data.js');
}

applyMigration().catch(async (err) => {
    console.error('Migration error:', err.message);
    await client.end();
    process.exit(1);
});
