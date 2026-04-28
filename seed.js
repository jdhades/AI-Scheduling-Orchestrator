const { Client } = require('pg');
const fs = require('fs');

const client = new Client({
  connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
});

async function runSeed() {
  await client.connect();
  const sql = fs.readFileSync('/home/jhav/ai-scheduling-orchestrator/supabase/seed.sql', 'utf-8');
  await client.query(sql);
  console.log('Seeded successfully');
  await client.end();
}

runSeed().catch(err => {
  console.error("Error seeding:", err);
  process.exit(1);
});
