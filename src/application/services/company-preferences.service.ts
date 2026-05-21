import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WeekStartsOn } from '../../domain/shared/week';

/**
 * CompanyPreferencesService — lookup cacheado de preferencias tenant-wide
 * (por ahora solo `week_starts_on`). Se hitea desde múltiples handlers
 * (schedule generation, query handlers, conversational layer) y la fila
 * raramente cambia, así que cacheamos en memoria con TTL para evitar
 * round-trips por cada operación.
 *
 * Invalidación: el endpoint PATCH /settings/company llama `invalidate(companyId)`
 * tras persistir el cambio.
 */
@Injectable()
export class CompanyPreferencesService {
  private readonly logger = new Logger(CompanyPreferencesService.name);
  private readonly cache = new Map<string, { weekStartsOn: WeekStartsOn; cachedAt: number }>();
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async getWeekStartsOn(companyId: string): Promise<WeekStartsOn> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.cachedAt < CompanyPreferencesService.TTL_MS) {
      return cached.weekStartsOn;
    }
    const { data, error } = await this.supabase
      .from('companies')
      .select('week_starts_on')
      .eq('id', companyId)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `Failed to fetch week_starts_on for company=${companyId}: ${error.message}. Falling back to 'monday'.`,
      );
      return 'monday';
    }
    const value = (data?.week_starts_on as WeekStartsOn | undefined) ?? 'monday';
    this.cache.set(companyId, { weekStartsOn: value, cachedAt: Date.now() });
    return value;
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }
}
