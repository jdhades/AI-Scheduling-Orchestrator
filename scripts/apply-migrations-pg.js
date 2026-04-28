const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
    connectionString: 'postgres://postgres:postgres@localhost:54322/postgres'
});

async function applyMigrations() {
    try {
        await client.connect();
        console.log('Connected to local Postgres');

        // Apply Scenario 6 availability preferences
        const sc6a = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260310000000_scenario6_availability_preferences.sql'), 'utf-8');
        console.log('Applying 20260310000000...');
        await client.query(sc6a);

        const sc6b = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260310000001_scenario6_shift_templates.sql'), 'utf-8');
        console.log('Applying 20260310000001...');
        await client.query(sc6b);

        // Apply V2 Architecture
        const v2 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260328000000_v2_enterprise_schema.sql'), 'utf-8');
        console.log('Applying 20260328000000_v2_enterprise_schema...');
        await client.query(v2);

        // Notify PostgREST to reload schema cache
        console.log('Reloading PostgREST schema cache...');
        await client.query("NOTIFY pgrst, 'reload schema';");

        console.log('✅ Migrations applied successfully!');
    } catch (e) {
        console.error('Error applying migrations:', e);
    } finally {
        await client.end();
    }
}

applyMigrations();
