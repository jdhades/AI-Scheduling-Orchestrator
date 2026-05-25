import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WeekStartsOn } from '../../domain/shared/week';

export type LlmProvider = 'qwen' | 'gemini' | 'local';

export interface CompanyLlmConfig {
  /** null = fallback al env-wide `AI_ACTIVE_PROVIDER`. */
  provider: LlmProvider | null;
  /** null = default del provider. */
  model: string | null;
}

interface CachedPrefs {
  weekStartsOn: WeekStartsOn;
  llmConfig: CompanyLlmConfig;
  cachedAt: number;
}

/**
 * CompanyPreferencesService — lookup cacheado de preferencias tenant-wide.
 * Hoy: `week_starts_on` + `llm_provider` / `llm_model`.
 *
 * Se hitea desde múltiples handlers (schedule generation, query handlers,
 * conversational layer); la fila raramente cambia → cache en memoria con
 * TTL para evitar round-trips por cada operación.
 *
 * Invalidación: los endpoints PATCH /settings/company y /admin/companies/
 * :id/llm-config llaman `invalidate(companyId)` tras persistir el cambio.
 */
@Injectable()
export class CompanyPreferencesService {
  private readonly logger = new Logger(CompanyPreferencesService.name);
  private readonly cache = new Map<string, CachedPrefs>();
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async getWeekStartsOn(companyId: string): Promise<WeekStartsOn> {
    const prefs = await this._fetchAndCache(companyId);
    return prefs.weekStartsOn;
  }

  async getLlmConfig(companyId: string): Promise<CompanyLlmConfig> {
    const prefs = await this._fetchAndCache(companyId);
    return prefs.llmConfig;
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  private async _fetchAndCache(companyId: string): Promise<CachedPrefs> {
    const cached = this.cache.get(companyId);
    if (
      cached &&
      Date.now() - cached.cachedAt < CompanyPreferencesService.TTL_MS
    ) {
      return cached;
    }
    const { data, error } = await this.supabase
      .from('companies')
      .select('week_starts_on, llm_provider, llm_model')
      .eq('id', companyId)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `Failed to fetch prefs for company=${companyId}: ${error.message}. Using defaults.`,
      );
      return {
        weekStartsOn: 'monday',
        llmConfig: { provider: null, model: null },
        cachedAt: Date.now(),
      };
    }
    const value: CachedPrefs = {
      weekStartsOn:
        (data?.week_starts_on as WeekStartsOn | undefined) ?? 'monday',
      llmConfig: {
        provider: (data?.llm_provider as LlmProvider | null) ?? null,
        model: (data?.llm_model as string | null) ?? null,
      },
      cachedAt: Date.now(),
    };
    this.cache.set(companyId, value);
    return value;
  }
}
