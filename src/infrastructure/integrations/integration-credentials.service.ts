import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Provider conocido para integrations. Stripe queda fuera porque su
 * webhook signing secret necesita estabilidad — vive en .env.
 */
export type IntegrationProvider =
  | 'twilio'
  | 'resend'
  | 'qwen'
  | 'gemini'
  | 'local_llm';

export type IntegrationEnvironment = 'test' | 'production';

export interface IntegrationConfig {
  enabled: boolean;
  /** Credenciales descifradas — JSON arbitrario por provider. */
  credentials: Record<string, string | number | boolean | null>;
  /** Metadata pública (sin secretos): last_test_at, model name, etc. */
  metadata: Record<string, unknown>;
}

export interface IntegrationListItem {
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  enabled: boolean;
  hasCredentials: boolean;
  metadata: Record<string, unknown>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string;
}

/**
 * Evento que se dispara cuando una integración cambia (admin guarda
 * desde /admin/integrations). Los services del backend (TwilioService,
 * EmailService, QwenLLMService, etc.) escuchan y re-inicializan su
 * cliente sin necesidad de restartear el container.
 */
export const INTEGRATION_UPDATED_EVENT = 'integration.updated';
export interface IntegrationUpdatedPayload {
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
}

/**
 * IntegrationCredentialsService
 *
 * Lee/escribe credenciales de APIs externas desde la tabla
 * `integration_credentials` + Vault. Cache en memoria con invalidación
 * por evento.
 *
 * Los services consumers (TwilioService, EmailService, etc.) inyectan
 * este service y llaman `get(provider, env)` en su onModuleInit() +
 * subscriben al evento `integration.updated` para reload dinámico.
 *
 * NOTA: solo lee la cred del environment activo. La selección de
 * test vs production se hace por env var `INTEGRATION_ENV` (default
 * 'test' en staging, 'production' en prod-real). El admin puede tener
 * ambas configuradas en DB; el backend solo lee la del active env.
 */
@Injectable()
export class IntegrationCredentialsService {
  private readonly logger = new Logger(IntegrationCredentialsService.name);
  private readonly cache = new Map<string, IntegrationConfig | null>();
  private readonly activeEnvironment: IntegrationEnvironment;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly events: EventEmitter2,
  ) {
    const env = process.env.INTEGRATION_ENV;
    this.activeEnvironment = env === 'production' ? 'production' : 'test';
    this.logger.log(
      `IntegrationCredentialsService active environment=${this.activeEnvironment}`,
    );
  }

  /**
   * Devuelve la config del provider en el environment activo. Cachea.
   * Si no hay row o tiene enabled=false, devuelve null — el caller
   * decide qué hacer (típicamente: no-op).
   */
  async get(provider: IntegrationProvider): Promise<IntegrationConfig | null> {
    return this.getForEnvironment(provider, this.activeEnvironment);
  }

  /** Lectura cruda en cualquier env. Para el panel de admin. */
  async getForEnvironment(
    provider: IntegrationProvider,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationConfig | null> {
    const key = `${provider}:${environment}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    const { data, error } = await this.supabase.rpc(
      'get_integration_credential',
      { p_provider: provider, p_environment: environment },
    );
    if (error) {
      this.logger.warn(
        `get_integration_credential(${provider}, ${environment}) failed: ${error.message}`,
      );
      this.cache.set(key, null);
      return null;
    }
    const row = (data as Array<IntegrationConfig> | null)?.[0] ?? null;
    this.cache.set(key, row);
    return row;
  }

  /**
   * Upsert + emit event para que los services consumers se re-inicialicen.
   */
  async upsert(args: {
    provider: IntegrationProvider;
    environment: IntegrationEnvironment;
    credentials: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<void> {
    const { error } = await this.supabase.rpc('upsert_integration_credential', {
      p_provider: args.provider,
      p_environment: args.environment,
      p_secret_json: args.credentials,
      p_metadata: args.metadata ?? {},
      p_enabled: args.enabled ?? false,
    });
    if (error) {
      throw new Error(`upsert_integration_credential failed: ${error.message}`);
    }
    this.invalidate(args.provider, args.environment);
    this.events.emit(INTEGRATION_UPDATED_EVENT, {
      provider: args.provider,
      environment: args.environment,
    } satisfies IntegrationUpdatedPayload);
  }

  /**
   * Lista todas las integraciones (sin descifrar) para la UI del admin.
   * Devuelve también las que no existen todavía como placeholder.
   */
  async list(): Promise<IntegrationListItem[]> {
    const { data, error } = await this.supabase
      .from('integration_credentials')
      .select(
        'provider, environment, enabled, vault_secret_id, metadata, last_test_at, last_test_ok, last_test_error, updated_at',
      );
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      provider: r.provider as IntegrationProvider,
      environment: r.environment as IntegrationEnvironment,
      enabled: r.enabled as boolean,
      hasCredentials: !!r.vault_secret_id,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      lastTestAt: (r.last_test_at as string | null) ?? null,
      lastTestOk: (r.last_test_ok as boolean | null) ?? null,
      lastTestError: (r.last_test_error as string | null) ?? null,
      updatedAt: r.updated_at as string,
    }));
  }

  /**
   * Marca un test connection result. Lo invocan los handlers del
   * /test-connection endpoint después de hacer el dry-run.
   */
  async recordTestResult(
    provider: IntegrationProvider,
    environment: IntegrationEnvironment,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    const { error: updErr } = await this.supabase
      .from('integration_credentials')
      .update({
        last_test_at: new Date().toISOString(),
        last_test_ok: ok,
        last_test_error: error,
      })
      .eq('provider', provider)
      .eq('environment', environment);
    if (updErr) {
      this.logger.warn(`recordTestResult failed: ${updErr.message}`);
    }
  }

  /** Invalida la cache de un provider — uso interno + tests. */
  invalidate(
    provider: IntegrationProvider,
    environment: IntegrationEnvironment,
  ): void {
    this.cache.delete(`${provider}:${environment}`);
  }

  /** Active env actual. Útil para que los services consumers sepan
   * cuál config aplica. */
  get activeEnv(): IntegrationEnvironment {
    return this.activeEnvironment;
  }
}
