import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LLMUsageLogger,
  type UsageSummary,
} from '../../infrastructure/observability/llm-usage-logger.service';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

export interface ErrorRateRow {
  operation: string;
  successCount: number;
  errorCount: number;
  errorRate: number; // 0..1
}

/**
 * AdminLLMUsageController — cross-tenant view del gasto LLM.
 *
 *   GET /admin/llm-usage/summary?days=N[&companyId=...]
 *   GET /admin/llm-usage/daily?days=N[&companyId=...]
 *
 * Sin `companyId`: agrega TODOS los tenants (visión global de costos).
 * Con `companyId`: filtra a ese tenant.
 *
 * Espejo de /llm-usage/{summary,daily} pero sin el `@CurrentCompany()`
 * forzado. Pensado para que el admin de soporte pueda comparar costos
 * entre clientes o ver el total del SaaS.
 */
@Controller('admin/llm-usage')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminLLMUsageController {
  constructor(
    private readonly logger: LLMUsageLogger,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('summary')
  async summary(
    @Query('days') days?: string,
    @Query('companyId') companyId?: string,
  ): Promise<UsageSummary> {
    const n = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    return this.logger.summary(n, companyId);
  }

  @Get('daily')
  async daily(
    @Query('days') days?: string,
    @Query('companyId') companyId?: string,
  ): Promise<
    Array<{
      date: string;
      calls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }>
  > {
    const n = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    return this.logger.daily(n, companyId);
  }

  /**
   * GET /admin/llm-usage/error-rates?days=N[&companyId=...]
   *
   * Lee llm_prompt_history (que sí registra success=false en fallos) y
   * computa success / error count + ratio por operation. llm_usage_log
   * solo tiene rows de calls exitosas, no sirve para esto.
   */
  @Get('error-rates')
  async errorRates(
    @Query('days') days?: string,
    @Query('companyId') companyId?: string,
  ): Promise<ErrorRateRow[]> {
    const n = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    let query = this.supabase
      .from('llm_prompt_history')
      .select('operation, success')
      .gte('created_at', since);
    if (companyId) query = query.eq('company_id', companyId);
    const { data, error } = await query;
    if (error) return [];

    const byOp = new Map<
      string,
      { success: number; error: number }
    >();
    for (const r of data ?? []) {
      const op = r.operation as string;
      const acc = byOp.get(op) ?? { success: 0, error: 0 };
      if (r.success) acc.success += 1;
      else acc.error += 1;
      byOp.set(op, acc);
    }
    return Array.from(byOp.entries())
      .map(([operation, acc]) => {
        const total = acc.success + acc.error;
        return {
          operation,
          successCount: acc.success,
          errorCount: acc.error,
          errorRate: total === 0 ? 0 : acc.error / total,
        };
      })
      .sort((a, b) => b.errorCount - a.errorCount);
  }
}
