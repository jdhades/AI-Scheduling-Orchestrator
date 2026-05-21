import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  OperationalKpisService,
  type OperationalKpis,
} from '../../domain/services/operational-kpis.service';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';

/**
 * OperationalKpisController — KPIs tenant-wide para el manager/owner.
 *
 * GET /insights/operational-kpis?weekStarts=YYYY-MM-DD,YYYY-MM-DD
 *   → coverage avg, approval rate, fairness CV avg, generaciones del período.
 *
 * El frontend pasa el mismo array `weekStarts` que el filtro de período
 * usa para los otros widgets (1 elem en mode=week, N en mode=month).
 */
@Controller('insights/operational-kpis')
export class OperationalKpisController {
  constructor(
    private readonly kpisService: OperationalKpisService,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  @Get()
  async getKpis(
    @CurrentCompany() companyId: string,
    @Query('weekStarts') weekStartsParam: string,
  ): Promise<OperationalKpis> {
    if (!weekStartsParam) {
      throw new BadRequestException(
        'weekStarts query param requerido (formato: CSV de YYYY-MM-DD)',
      );
    }
    const weekStarts = weekStartsParam.split(',').map((s) => s.trim());
    for (const ws of weekStarts) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) {
        throw new BadRequestException(
          `weekStarts contiene un valor inválido: "${ws}" (esperado YYYY-MM-DD)`,
        );
      }
    }
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    return this.kpisService.getKpis(companyId, weekStarts, weekStartsOn);
  }
}
