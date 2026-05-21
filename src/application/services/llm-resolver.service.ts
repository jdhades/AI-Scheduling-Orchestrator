import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_SERVICE, type ILLMService } from '../../domain/services/llm.service.interface';
import { QwenLLMService } from '../../infrastructure/services/qwen-llm.service';
import { GeminiLLMService } from '../../infrastructure/services/gemini-llm.service';
import { LocalLLMService } from '../../infrastructure/services/local-llm.service';
import { CompanyPreferencesService } from './company-preferences.service';

/**
 * LlmResolverService
 *
 * Devuelve el ILLMService apropiado según la preferencia per-tenant. Si
 * la company no tiene `llm_provider` seteado (NULL en BD), cae al
 * env-wide configurado en `ai.activeProvider`.
 *
 * Uso:
 *   const llm = await resolver.forCompany(companyId);
 *   const out = await llm.complete(prompt);
 *
 * Para consumidores sin contexto de company (background jobs sin tenant):
 *   const llm = resolver.default();
 *
 * v1: solo `LLMLineProposerService` (schedule generation) usa el
 * resolver. Los otros consumidores de `LLM_SERVICE` (rule rephrase,
 * policy match, whatsapp classify) siguen con el default env-wide vía
 * la inyección directa. Pasada siguiente: migrar todos al resolver.
 */
@Injectable()
export class LlmResolverService {
  private readonly logger = new Logger(LlmResolverService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly qwen: QwenLLMService,
    private readonly gemini: GeminiLLMService,
    private readonly local: LocalLLMService,
    private readonly companyPreferences: CompanyPreferencesService,
    @Inject(LLM_SERVICE) private readonly envDefault: ILLMService,
  ) {}

  async forCompany(companyId: string): Promise<ILLMService> {
    const cfg = await this.companyPreferences.getLlmConfig(companyId);
    if (!cfg.provider) {
      return this.envDefault;
    }
    switch (cfg.provider) {
      case 'qwen':
        return this.qwen;
      case 'gemini':
        return this.gemini;
      case 'local':
        return this.local;
      default:
        this.logger.warn(
          `Unknown llm_provider="${cfg.provider}" for company=${companyId}. Falling back to env default.`,
        );
        return this.envDefault;
    }
  }

  default(): ILLMService {
    return this.envDefault;
  }
}
