/**
 * seed-platform-admin.ts — Bootstrap del primer platform_admin.
 *
 * Idempotente. Crea (o reusa) un auth.users y lo promueve a
 * platform_admin con role 'super'. Limpia la company "fantasma" que
 * crea el trigger handle_new_user (Path 2 self-signup).
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm exec ts-node scripts/seed-platform-admin.ts \
 *     --email admin@platform.local \
 *     --password 'StrongPass1234!' \
 *     [--role super|support]   (default: super)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '.env') });

interface CliArgs {
  email: string;
  password: string;
  role: 'super' | 'support';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  const email = get('--email');
  const password = get('--password');
  if (!email || !password) {
    console.error(
      'Usage: seed-platform-admin --email <e> --password <p> [--role super|support]',
    );
    process.exit(1);
  }
  const role = (get('--role') ?? 'super') as 'super' | 'support';
  if (role !== 'super' && role !== 'support') {
    console.error(`Invalid role "${role}". Must be 'super' or 'support'.`);
    process.exit(1);
  }
  return { email, password, role };
}

async function main() {
  const { email, password, role } = parseArgs();

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
    process.exit(1);
  }
  const supabase = createClient(url, serviceRole);

  // 1) Localizar / crear el auth.users.
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  let user = (existingUsers?.users ?? []).find(
    (u: { email?: string }) => u.email === email,
  );

  if (!user) {
    console.log(`[seed-pa] Creating auth.users for ${email}...`);
    const { data: created, error: createErr } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { created_by: 'seed-platform-admin' },
      });
    if (createErr || !created.user) {
      console.error('Failed to create auth user:', createErr?.message);
      process.exit(1);
    }
    user = created.user;
    console.log(`[seed-pa] Created auth.users id=${user.id}`);
  } else {
    console.log(`[seed-pa] Reusing existing auth.users id=${user.id}`);
  }

  // 2) Borrar la company "fantasma" si el trigger handle_new_user la
  //    creó (Path 2). El platform_admin no debería ser dueño de una
  //    company — opera cross-tenant. La FK ON DELETE CASCADE de
  //    employees/branches/onboarding_drafts limpia el resto.
  const { data: ghostEmp } = await supabase
    .from('employees')
    .select('id, company_id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (ghostEmp?.company_id) {
    console.log(
      `[seed-pa] Removing ghost company ${ghostEmp.company_id} created by trigger`,
    );
    const { error: delErr } = await supabase
      .from('companies')
      .delete()
      .eq('id', ghostEmp.company_id);
    if (delErr) {
      console.warn(`[seed-pa] WARN: ghost company delete failed: ${delErr.message}`);
    }
  }

  // 3) UPSERT en platform_admins. UNIQUE(auth_user_id) hace que sea
  //    idempotente — si ya existe, actualiza role.
  const { data: paRow, error: paErr } = await supabase
    .from('platform_admins')
    .upsert(
      { auth_user_id: user.id, email, role },
      { onConflict: 'auth_user_id' },
    )
    .select('id, role')
    .single();
  if (paErr) {
    console.error('Failed to upsert platform_admins:', paErr.message);
    process.exit(1);
  }

  console.log(
    `[seed-pa] ✅ Platform admin ready: id=${paRow.id} email=${email} role=${paRow.role}`,
  );
  console.log(`[seed-pa] Login en /login con ${email} → habilita /admin/*`);
}

void main();
