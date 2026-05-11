import { Controller, Get, Query } from '@nestjs/common';
import {
  LLMUsageLogger,
  type UsageSummary,
} from '../../infrastructure/observability/llm-usage-logger.service';

/**
 * GET /llm-usage/summary?days=N&companyId=...
 *
 * Agregados de costo del LLM últimos N días, totales + breakdown por
 * `operation` (subsistema) y por `model`. Read-only para el dashboard.
 *
 * Si no se pasa `companyId`, agrega TODOS los tenants — útil para una
 * vista admin global. Si se pasa, filtra al tenant.
 *
 * Default days=7. Cap interno [1..90] para evitar queries pesadas
 * accidentales sin paginación.
 */
@Controller('llm-usage')
export class LLMUsageController {
  constructor(private readonly logger: LLMUsageLogger) {}

  @Get('summary')
  async summary(
    @Query('days') days?: string,
    @Query('companyId') companyId?: string,
  ): Promise<UsageSummary> {
    const n = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    return this.logger.summary(n, companyId);
  }

  /**
   * GET /llm-usage/daily?days=N&companyId=...
   *
   * Buckets por día (YYYY-MM-DD) con totales — para sparklines del
   * dashboard. Rellena días sin actividad con 0 para que el chart
   * tenga la cantidad esperada de puntos.
   */
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
