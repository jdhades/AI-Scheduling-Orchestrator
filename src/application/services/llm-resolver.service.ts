import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LLM_SERVICE,
  type ILLMService,
  type LLMCompleteOptions,
} from '../../domain/services/llm.service.interface';
import { QwenLLMService } from '../../infrastructure/services/qwen-llm.service';
import { GeminiLLMService } from '../../infrastructure/services/gemini-llm.service';
import { LocalLLMService } from '../../infrastructure/services/local-llm.service';
import { CompanyPreferencesService } from './company-preferences.service';
import { PromptHistoryService } from '../../infrastructure/observability/prompt-history.service';
import { LLMUsageLogger } from '../../infrastructure/observability/llm-usage-logger.service';
import { LLMModelBudgetService } from '../../domain/services/llm-model-budget.service';
import { CompanyLlmAllowlistService } from '../../domain/services/company-llm-allowlist.service';

export interface ResolverContext {
  /** Subsistema que disparó la call (ej. `schedule_generation`). */
  operation: string;
  /** jobId opcional cuando aplica (ej. schedule_generation_runs). */
  jobId?: string | null;
}

/**
 * Excepción dedicada al hit de budget. El handler de schedule
 * generation (y futuros consumers) la propaga sin retry — el manager
 * debe contactar a soporte para subir el techo o esperar al rollover
 * del mes.
 */
export class LlmBudgetExceededException extends ForbiddenException {
  constructor(
    public readonly companyId: string,
    public readonly model: string,
    public readonly usedTokens: number,
    public readonly budgetTokens: number,
  ) {
    super({
      error: 'llm_budget_exceeded',
      message: `LLM monthly budget exceeded for model "${model}": ${usedTokens}/${budgetTokens} tokens`,
      companyId,
      model,
      usedTokens,
      budgetTokens,
    });
  }
}

/**
 * Excepción dedicada al fail del check de whitelist. El tenant tiene
 * una allowlist configurada y el (provider, model) que el resolver
 * eligió no está en ella. Soporte resuelve o agregando el modelo a la
 * allowlist o cambiando companies.llm_provider / llm_model.
 */
export class LlmProviderNotAllowedException extends ForbiddenException {
  constructor(
    public readonly companyId: string,
    public readonly provider: string,
    public readonly model: string,
  ) {
    super({
      error: 'llm_provider_not_allowed',
      message: `LLM provider/model "${provider}:${model}" is not on this tenant's allowlist`,
      companyId,
      provider,
      model,
    });
  }
}

/**
 * LlmResolverService
 *
 * Devuelve el ILLMService apropiado según la preferencia per-tenant.
 * Si la company no tiene `llm_provider` seteado (NULL en BD), cae al
 * env-wide configurado en `ai.activeProvider`.
 *
 * Además: si se pasa `ResolverContext`, envuelve el LLM en un proxy
 * que persiste cada llamada en `llm_prompt_history` (fire-and-forget).
 *
 * Uso típico:
 *   const llm = await resolver.forCompany(companyId, { operation: 'schedule_generation', jobId });
 *   const out = await llm.complete(prompt);
 *
 * Sin contexto (background sin tenant):
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
    private readonly promptHistory: PromptHistoryService,
    @Inject(LLM_SERVICE) private readonly envDefault: ILLMService,
    private readonly usageLogger: LLMUsageLogger,
    private readonly budgets: LLMModelBudgetService,
    private readonly allowlist: CompanyLlmAllowlistService,
  ) {}

  async forCompany(
    companyId: string,
    context?: ResolverContext,
  ): Promise<ILLMService> {
    const cfg = await this.companyPreferences.getLlmConfig(companyId);
    const base = this._pickProvider(cfg.provider, companyId);
    const modelLabel = cfg.model ?? cfg.provider ?? null;
    const providerLabel = cfg.provider ?? null;

    // Allowlist enforcement — si el tenant tiene whitelist configurada
    // y el (provider, model) elegido NO está en ella, rechazamos. Sin
    // filas en allowlist → cualquier modelo permitido (compat).
    if (providerLabel && modelLabel) {
      await this._enforceAllowlist(companyId, providerLabel, modelLabel);
    }

    // Budget enforcement — chequeo previo al return del LLM service.
    // Si el tenant tiene budget configurado (override o global) y ya
    // consumió >= ese techo este mes, tiramos LlmBudgetExceededException.
    // Sin budget configurado → sin enforcement (fail-open por compat).
    if (modelLabel) {
      await this._enforceBudget(companyId, modelLabel);
    }

    if (!context) return base;
    return this._wrapWithLogging(base, {
      companyId,
      operation: context.operation,
      jobId: context.jobId ?? null,
      modelLabel,
    });
  }

  /**
   * Chequea que el (provider, model) elegido esté en la whitelist del
   * tenant. Si la company no tiene filas en allowlist, todo permitido.
   * Si tiene filas y el (provider, model) no aparece, lanza.
   */
  private async _enforceAllowlist(
    companyId: string,
    provider: string,
    model: string,
  ): Promise<void> {
    const allowed = await this.allowlist.isAllowed(companyId, provider, model);
    if (!allowed) {
      this.logger.warn(
        `LLM provider not allowed — company=${companyId} provider=${provider} model=${model}`,
      );
      throw new LlmProviderNotAllowedException(companyId, provider, model);
    }
  }

  /**
   * Lee el budget efectivo (override company > default global) y el
   * consumo del mes. Si excede, lanza. El check se hace en el resolve,
   * NO antes de cada call dentro del proxy — alcanza con bloquear la
   * obtención del cliente cuando se va a iniciar un job nuevo.
   */
  private async _enforceBudget(
    companyId: string,
    model: string,
  ): Promise<void> {
    const budgetTokens = await this.budgets.getEffectiveBudget(
      companyId,
      model,
    );
    if (budgetTokens === null) return; // sin techo configurado
    const used = await this.usageLogger.monthlyTokensUsed(companyId, model);
    if (used >= budgetTokens) {
      this.logger.warn(
        `Budget exceeded — company=${companyId} model=${model} used=${used}/${budgetTokens}`,
      );
      throw new LlmBudgetExceededException(
        companyId,
        model,
        used,
        budgetTokens,
      );
    }
  }

  default(): ILLMService {
    return this.envDefault;
  }

  private _pickProvider(
    provider: 'qwen' | 'gemini' | 'local' | null,
    companyId: string,
  ): ILLMService {
    if (!provider) return this.envDefault;
    switch (provider) {
      case 'qwen':
        return this.qwen;
      case 'gemini':
        return this.gemini;
      case 'local':
        return this.local;
      default:
        this.logger.warn(
          `Unknown llm_provider="${provider}" for company=${companyId}. Falling back to env default.`,
        );
        return this.envDefault;
    }
  }

  /**
   * Wrap el ILLMService en un proxy que persiste cada call en
   * llm_prompt_history. Captura prompt + response + duración + status.
   * Los tokens se loguean aparte vía `LLMUsageTracker`; acá guardamos
   * el snapshot textual para auditoría/debug.
   */
  private _wrapWithLogging(
    base: ILLMService,
    ctx: {
      companyId: string | null;
      operation: string;
      jobId: string | null;
      modelLabel: string | null;
    },
  ): ILLMService {
    const history = this.promptHistory;
    return {
      async complete(
        prompt: string,
        options?: LLMCompleteOptions,
      ): Promise<string> {
        const start = Date.now();
        try {
          // Inyectamos el modelo del tenant ANTES de llamar al base.
          // El caller puede haber pasado un override (ej. tests), en cuyo
          // caso respetamos el del caller — sino ganamos con ctx.modelLabel.
          const effectiveOptions: LLMCompleteOptions = {
            ...options,
            model: options?.model ?? ctx.modelLabel ?? undefined,
          };
          const response = await base.complete(prompt, effectiveOptions);
          history.record({
            companyId: ctx.companyId,
            operation: ctx.operation,
            promptText: prompt,
            responseText: response,
            modelUsed: ctx.modelLabel,
            tokensUsed: null,
            durationMs: Date.now() - start,
            success: true,
            errorMessage: null,
            jobId: ctx.jobId,
          });
          return response;
        } catch (err) {
          history.record({
            companyId: ctx.companyId,
            operation: ctx.operation,
            promptText: prompt,
            responseText: null,
            modelUsed: ctx.modelLabel,
            tokensUsed: null,
            durationMs: Date.now() - start,
            success: false,
            errorMessage: (err as Error).message,
            jobId: ctx.jobId,
          });
          throw err;
        }
      },
    };
  }
}
