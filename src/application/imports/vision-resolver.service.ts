import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { AnthropicVisionService } from '../../infrastructure/services/anthropic-vision.service';
import type { IVisionExtractor } from './vision-extractor.interface';

type VisionProvider = 'anthropic' | 'gemini' | 'qwen';

interface TenantVisionConfig {
  provider: VisionProvider;
  model: string | null;
}

/**
 * VisionResolverService — devuelve el extractor configurado por el
 * tenant.
 *
 * Lee `companies.imports_vision_provider` + `imports_vision_model`
 * (cacheable, pero por ahora es read directo: la operación es 1/upload).
 *
 * Fase 3 ships solo con Anthropic. Gemini/Qwen vision quedan stub:
 * cuando un tenant los pida, throw con mensaje explicativo. Sumarlos
 * después es solo escribir el service e injectarlo acá.
 */
@Injectable()
export class VisionResolverService {
  private readonly logger = new Logger(VisionResolverService.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly anthropic: AnthropicVisionService,
  ) {}

  /**
   * Resuelve el extractor para el tenant + devuelve `{ extractor, model }`.
   * `model` es el override del tenant o el default del extractor — el
   * caller lo pasa en `VisionExtractInput.modelOverride` (que admite
   * null = usar el default del provider).
   */
  async forCompany(companyId: string): Promise<{
    extractor: IVisionExtractor;
    model: string | null;
  }> {
    const config = await this.loadConfig(companyId);
    const extractor = this.pick(config.provider);
    return { extractor, model: config.model };
  }

  private pick(provider: VisionProvider): IVisionExtractor {
    switch (provider) {
      case 'anthropic':
        return this.anthropic;
      case 'gemini':
      case 'qwen':
        // Stub explícito — cuando se sume el service, reemplazar acá.
        throw new Error(
          `Vision provider "${provider}" not implemented yet. Switch the tenant to "anthropic" in /admin/companies/:id, or wait until the vision service for ${provider} ships.`,
        );
    }
  }

  private async loadConfig(companyId: string): Promise<TenantVisionConfig> {
    const { data, error } = await this.supabase
      .from('companies')
      .select('imports_vision_provider, imports_vision_model')
      .eq('id', companyId)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `VisionResolverService: failed to load config for ${companyId}: ${error.message}. Falling back to anthropic default.`,
      );
      return { provider: 'anthropic', model: null };
    }
    const row = data as {
      imports_vision_provider?: VisionProvider | null;
      imports_vision_model?: string | null;
    } | null;
    return {
      provider: row?.imports_vision_provider ?? 'anthropic',
      model: row?.imports_vision_model ?? null,
    };
  }
}
