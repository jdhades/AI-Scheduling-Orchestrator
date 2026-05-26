import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import {
  IntegrationCredentialsService,
  type IntegrationEnvironment,
  type IntegrationListItem,
  type IntegrationProvider,
} from '../../infrastructure/integrations/integration-credentials.service';
import { TwilioService } from '../../infrastructure/notifications/twilio.service';
import { EmailService } from '../../infrastructure/notifications/email.service';
import { QwenLLMService } from '../../infrastructure/services/qwen-llm.service';
import { GeminiLLMService } from '../../infrastructure/services/gemini-llm.service';
import { LocalLLMService } from '../../infrastructure/services/local-llm.service';

const VALID_PROVIDERS = [
  'twilio',
  'resend',
  'qwen',
  'gemini',
  'local_llm',
] as const satisfies readonly IntegrationProvider[];

const VALID_ENVS = ['test', 'production'] as const satisfies readonly IntegrationEnvironment[];

export class UpsertIntegrationDto {
  @IsObject()
  credentials!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class TestIntegrationDto {
  @IsObject()
  credentials!: Record<string, unknown>;
}

/**
 * AdminIntegrationsController
 *
 * Solo platform_admin (super/support). Gestiona las credenciales de
 * APIs externas (Twilio, Resend, LLM providers) desde la UI cross-tenant.
 *
 *   GET    /admin/integrations
 *   GET    /admin/integrations/:provider
 *   PUT    /admin/integrations/:provider/:environment
 *   POST   /admin/integrations/:provider/:environment/test
 */
@Controller('admin/integrations')
@PlatformAdmin()
export class AdminIntegrationsController {
  constructor(
    private readonly creds: IntegrationCredentialsService,
    private readonly twilio: TwilioService,
    private readonly email: EmailService,
    private readonly qwen: QwenLLMService,
    private readonly gemini: GeminiLLMService,
    private readonly local: LocalLLMService,
  ) {}

  /**
   * GET /admin/integrations — listado completo (sin secretos).
   * El UI lo usa para el grid principal.
   */
  @Get()
  async list(): Promise<{
    activeEnv: IntegrationEnvironment;
    integrations: IntegrationListItem[];
  }> {
    return {
      activeEnv: this.creds.activeEnv,
      integrations: await this.creds.list(),
    };
  }

  /**
   * GET /admin/integrations/:provider — detalle de un provider en
   * ambos environments (test + production). Incluye las credentials
   * descifradas — solo platform_admin las ve.
   */
  @Get(':provider')
  async getByProvider(@Param('provider') provider: string): Promise<{
    provider: IntegrationProvider;
    activeEnv: IntegrationEnvironment;
    test: { enabled: boolean; credentials: Record<string, unknown>; metadata: Record<string, unknown> } | null;
    production: { enabled: boolean; credentials: Record<string, unknown>; metadata: Record<string, unknown> } | null;
  }> {
    this.assertValidProvider(provider);
    const p = provider as IntegrationProvider;
    const [test, production] = await Promise.all([
      this.creds.getForEnvironment(p, 'test'),
      this.creds.getForEnvironment(p, 'production'),
    ]);
    return {
      provider: p,
      activeEnv: this.creds.activeEnv,
      test,
      production,
    };
  }

  /**
   * PUT /admin/integrations/:provider/:environment — upsert + reload.
   * Body: { credentials, metadata?, enabled? }.
   *
   * Tras guardar emite event `integration.updated` → los services
   * consumers se re-inicializan automáticamente.
   */
  @Put(':provider/:environment')
  @HttpCode(HttpStatus.NO_CONTENT)
  async upsert(
    @Param('provider') provider: string,
    @Param('environment') environment: string,
    @Body() dto: UpsertIntegrationDto,
  ): Promise<void> {
    this.assertValidProvider(provider);
    this.assertValidEnvironment(environment);
    await this.creds.upsert({
      provider: provider as IntegrationProvider,
      environment: environment as IntegrationEnvironment,
      credentials: dto.credentials,
      metadata: dto.metadata,
      enabled: dto.enabled,
    });
  }

  /**
   * POST /admin/integrations/:provider/:environment/test — dry-run.
   * Las credenciales vienen en el body (el user puede testear ANTES de
   * guardar). El backend hace una llamada inocua al provider:
   *   - Twilio: account.fetch
   *   - Resend: emails.send a sí mismo
   *   - Qwen/Gemini/Local: completion con max_tokens=1
   * Persistimos resultado en last_test_at/ok/error.
   */
  @Post(':provider/:environment/test')
  @HttpCode(HttpStatus.OK)
  async testConnection(
    @Param('provider') provider: string,
    @Param('environment') environment: string,
    @Body() dto: TestIntegrationDto,
  ): Promise<{ ok: boolean; error?: string }> {
    this.assertValidProvider(provider);
    this.assertValidEnvironment(environment);
    const p = provider as IntegrationProvider;
    const result = await this.dispatchTest(p, dto.credentials);
    // Persistir resultado solo si la row existe (típicamente sí — el
    // user ya guardó al menos una vez). Si no existe todavía igual
    // devolvemos el resultado del dry-run sin fallar.
    await this.creds
      .recordTestResult(
        p,
        environment as IntegrationEnvironment,
        result.ok,
        result.error ?? null,
      )
      .catch(() => undefined);
    return result;
  }

  private async dispatchTest(
    provider: IntegrationProvider,
    creds: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    switch (provider) {
      case 'twilio':
        return this.twilio.testConnection(
          creds as { accountSid: string; authToken: string; fromNumber: string },
        );
      case 'resend':
        return this.email.testConnection(
          creds as { apiKey: string; from?: string },
        );
      case 'qwen':
        return this.qwen.testConnection(creds as { apiKey: string });
      case 'gemini':
        return this.gemini.testConnection(creds as { apiKey: string });
      case 'local_llm':
        return this.local.testConnection(
          creds as { baseUrl: string; model?: string },
        );
    }
  }

  private assertValidProvider(p: string): void {
    if (!(VALID_PROVIDERS as readonly string[]).includes(p)) {
      throw new BadRequestException(
        `Invalid provider "${p}". Allowed: ${VALID_PROVIDERS.join(', ')}`,
      );
    }
  }

  private assertValidEnvironment(e: string): void {
    if (!(VALID_ENVS as readonly string[]).includes(e)) {
      throw new BadRequestException(
        `Invalid environment "${e}". Allowed: ${VALID_ENVS.join(', ')}`,
      );
    }
  }
}
