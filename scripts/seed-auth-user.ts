/**
 * Seed user para desarrollo local. Crea:
 *   1. Una invitación pending para el email indicado (rol manager por
 *      default) en la company activa.
 *   2. Un usuario en `auth.users` con la password indicada.
 *   3. El trigger `auth.handle_new_user` se dispara automático: lookup
 *      de la invitation, INSERT en `employees` con auth_user_id linkeado,
 *      mark invitation consumed.
 *
 * Uso:
 *   npx tsx scripts/seed-auth-user.ts \
 *     --email manager@demo.local \
 *     --password "AVeryStrongPassword123!" \
 *     [--role manager|employee] \
 *     [--company 22222222-2222-3333-4444-555555555555]
 *
 * Idempotente: si el user ya existe en auth.users, sale 0 silencioso.
 * Si la invitación ya está pending, la reusa.
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '.env') });

interface CliArgs {
  email: string;
  password: string;
  role: 'manager' | 'employee';
  companyId: string;
  name: string;
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
      'Usage: seed-auth-user --email <e> --password <p> [--role manager|employee] [--company <uuid>] [--name "Full Name"]',
    );
    process.exit(1);
  }
  const role = (get('--role') ?? 'manager') as 'manager' | 'employee';
  const companyId = get('--company') ?? '22222222-2222-3333-4444-555555555555';
  const name = get('--name') ?? email.split('@')[0];
  return { email, password, role, companyId, name };
}

async function main() {
  const { email, password, role, companyId, name } = parseArgs();

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
    process.exit(1);
  }
  const supabase = createClient(url, serviceRole);

  // 1) Invitación pending — necesaria para que el trigger handle_new_user
  //    apruebe el signup.
  const { data: existingInv } = await supabase
    .from('auth_invitations')
    .select('id, token')
    .eq('email', email)
    .is('consumed_at', null)
    .maybeSingle();

  let invitationToken: string;
  if (existingInv) {
    console.log(`[seed] Reusing pending invitation ${existingInv.id}`);
    invitationToken = existingInv.token as string;
  } else {
    invitationToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { data: inv, error: invErr } = await supabase
      .from('auth_invitations')
      .insert({
        company_id: companyId,
        invited_by: null, // seed script — no manager origen
        email,
        role,
        token: invitationToken,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();
    if (invErr) {
      console.error('Failed to insert invitation:', invErr.message);
      process.exit(1);
    }
    console.log(`[seed] Created invitation ${inv.id}`);
  }

  // 2) Crear el user. Si ya existe, getUserByEmail devuelve la row;
  //    en ese caso skip el create.
  const { data: existing } = await supabase.auth.admin.listUsers();
  const exists = (existing?.users ?? []).find(
    (u: { email?: string }) => u.email === email,
  );
  if (exists) {
    console.log(`[seed] User ${email} already exists (id=${exists.id}); skip create`);
    // Verificar que esté linkeado a employee
    const { data: emp } = await supabase
      .from('employees')
      .select('id, role, company_id')
      .eq('auth_user_id', exists.id)
      .maybeSingle();
    if (emp) {
      console.log(
        `[seed] Linked employee id=${emp.id} role=${emp.role} company=${emp.company_id}`,
      );
    } else {
      console.warn(`[seed] WARNING: user exists but no linked employee row`);
    }
    return;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // saltea verificación de email para dev
    user_metadata: { name },
  });
  if (error) {
    console.error('Failed to create user:', error.message);
    process.exit(1);
  }

  console.log(`[seed] Created auth.users id=${data.user.id} email=${email}`);

  // 3) Confirmar que el trigger linkeó al employee.
  const { data: emp } = await supabase
    .from('employees')
    .select('id, role, company_id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();
  if (!emp) {
    console.warn(
      `[seed] WARNING: trigger handle_new_user did NOT create employee row. Check trigger is installed (migration 20260513000000).`,
    );
    process.exit(1);
  }
  console.log(
    `[seed] ✅ Linked employee id=${emp.id} role=${emp.role} company=${emp.company_id}`,
  );
  console.log(`[seed] Ready to login: ${email} / <password>`);
}

void main();
