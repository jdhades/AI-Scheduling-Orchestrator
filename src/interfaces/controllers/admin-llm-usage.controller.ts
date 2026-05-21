import { Controller, Get, Query } from '@nestjs/common';
import {
  LLMUsageLogger,
  type UsageSummary,
} from '../../infrastructure/observability/llm-usage-logger.service';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

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
  constructor(private readonly logger: LLMUsageLogger) {}

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
}
