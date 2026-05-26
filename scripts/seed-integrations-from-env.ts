/**
 * seed-integrations-from-env.ts — Bootstrap inicial de integration_credentials.
 *
 * Lee las variables sensibles del proceso (cargadas via dotenv del .env
 * pasado por SET -a) y las inserta en `public.integration_credentials`
 * como environment='test' con enabled=true. Después de esto, el backend
 * lee de DB y los services consumers reciben la config dinámicamente —
 * ya no es necesario tocar .env para cambiar credenciales.
 *
 * Idempotente: upsert por (provider, environment) — si ya existe,
 * actualiza. Vault.create_secret/update_secret bajo el capot.
 *
 * Uso:
 *   set -a && source ~/.supabase-orchestrator/staging.env && set +a
 *   pnpm exec ts-node scripts/seed-integrations-from-env.ts [--env test|production]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '.env') });

type Env = 'test' | 'production';

function parseEnv(): Env {
  const idx = process.argv.indexOf('--env');
  if (idx < 0) return 'test';
  const v = process.argv[idx + 1];
  if (v === 'test' || v === 'production') return v;
  throw new Error(`Invalid --env "${v}". Use 'test' or 'production'.`);
}

async function main() {
  const env = parseEnv();
  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, serviceRole);

  // Mapping provider → (credentials JSON, enabled flag).
  const integrations: Array<{
    provider: string;
    credentials: Record<string, unknown>;
    enabled: boolean;
    why: string;
  }> = [
    {
      provider: 'twilio',
      credentials: {
        accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
        authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
        fromNumber: process.env.TWILIO_FROM_NUMBER ?? '',
      },
      enabled:
        !!process.env.TWILIO_ACCOUNT_SID &&
        !!process.env.TWILIO_AUTH_TOKEN &&
        !!process.env.TWILIO_FROM_NUMBER,
      why: 'WhatsApp notifications via Twilio',
    },
    {
      provider: 'resend',
      credentials: {
        apiKey: process.env.RESEND_API_KEY ?? '',
        from: process.env.EMAIL_FROM ?? '',
      },
      enabled: !!process.env.RESEND_API_KEY,
      why: 'Transactional emails (invitations) via Resend',
    },
    {
      provider: 'qwen',
      credentials: {
        apiKey: process.env.QWEN_API_KEY ?? '',
      },
      enabled: !!process.env.QWEN_API_KEY,
      why: 'LLM provider (DashScope Qwen) for schedule generation',
    },
    {
      provider: 'gemini',
      credentials: {
        apiKey: process.env.GEMINI_API_KEY ?? '',
      },
      enabled: !!process.env.GEMINI_API_KEY,
      why: 'Alt LLM provider (Google Gemini)',
    },
    {
      provider: 'local_llm',
      credentials: {
        baseUrl: process.env.LLM_LOCAL_BASE_URL ?? '',
        model: process.env.LLM_LOCAL_MODEL ?? '',
      },
      enabled: !!process.env.LLM_LOCAL_BASE_URL,
      why: 'Local LLM endpoint (LM Studio, Ollama, etc.)',
    },
  ];

  for (const int of integrations) {
    if (!int.enabled) {
      console.log(
        `[seed-int] skipping ${int.provider} (${env}) — credentials not in .env`,
      );
      continue;
    }
    const { error } = await supabase.rpc('upsert_integration_credential', {
      p_provider: int.provider,
      p_environment: env,
      p_secret_json: int.credentials,
      p_metadata: { bootstrap_source: '.env', purpose: int.why },
      p_enabled: true,
    });
    if (error) {
      console.error(`[seed-int] ${int.provider} failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`[seed-int] ✅ ${int.provider} (${env}) configured + enabled`);
  }

  console.log('[seed-int] done.');
}

void main();
