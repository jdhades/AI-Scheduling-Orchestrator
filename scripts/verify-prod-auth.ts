/* eslint-disable no-console */
/**
 * verify-prod-auth.ts
 *
 * Smoke test del setup Auth en cualquier entorno (staging o prod):
 * verifica que el hook `custom_access_token` esté activo y emitiendo
 * los claims que el backend espera.
 *
 * Uso:
 *   pnpm tsx scripts/verify-prod-auth.ts \
 *     --supabase-url https://<proj>.supabase.co \
 *     --anon-key sb_publishable_... \
 *     --email <existing-user@example.com> \
 *     --password <secret>
 *
 * El script:
 *   1. Hace signInWithPassword contra Supabase.
 *   2. Decodifica el access_token (sin verificar firma — solo inspecciona).
 *   3. Reporta qué claims trae y cuáles faltan.
 *
 * Si faltan claims, el hook NO está activo o la function tiene un bug —
 * el backend caerá al fallback "lookup employees by auth_user_id" que es
 * 1 query extra por request (degradación de performance + path B menos
 * testeado).
 */

import { createClient } from '@supabase/supabase-js';

const REQUIRED_CLAIMS = [
  'company_id',
  'employee_id',
  'employee_role',
  'department_id',
] as const;

function parseArgs(): {
  url: string;
  key: string;
  email: string;
  password: string;
} {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '');
    const val = process.argv[i + 1];
    if (key && val) args.set(key, val);
  }
  const url = args.get('supabase-url');
  const key = args.get('anon-key');
  const email = args.get('email');
  const password = args.get('password');
  if (!url || !key || !email || !password) {
    console.error(
      'Usage: pnpm tsx scripts/verify-prod-auth.ts --supabase-url <url> --anon-key <key> --email <e> --password <p>',
    );
    process.exit(2);
  }
  return { url, key, email, password };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('Malformed JWT');
  // base64url → base64 → string
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const json = Buffer.from(b64 + pad, 'base64').toString('utf-8');
  return JSON.parse(json) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const { url, key, email, password } = parseArgs();
  console.log(`→ Connecting to ${url}`);
  const supabase = createClient(url, key);

  console.log(`→ Signing in as ${email}`);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) {
    console.error(`✗ signIn failed: ${error?.message ?? 'no session'}`);
    process.exit(1);
  }

  const claims = decodeJwtPayload(data.session.access_token);
  console.log('\n→ JWT payload:');
  console.log(JSON.stringify(claims, null, 2));

  console.log('\n→ Checking required custom claims…');
  const missing: string[] = [];
  for (const c of REQUIRED_CLAIMS) {
    if (claims[c] === undefined) {
      missing.push(c);
      console.log(`  ✗ ${c}: MISSING`);
    } else {
      console.log(`  ✓ ${c}: ${JSON.stringify(claims[c])}`);
    }
  }

  await supabase.auth.signOut();

  if (missing.length > 0) {
    console.error(
      `\n✗ Hook NOT active or buggy. Missing claims: ${missing.join(', ')}`,
    );
    console.error(
      '  Re-apply supabase/sql-extra/custom_access_token_hook_cloud.sql + activar el hook en Dashboard.',
    );
    process.exit(1);
  }

  console.log('\n✓ Hook active. JWT has all required custom claims.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
