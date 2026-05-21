import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  CoverageService,
  type CoverageReport,
} from '../../domain/services/coverage.service';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';

/**
 * CoverageController — read-only.
 *
 * GET /coverage?weekStart=YYYY-MM-DD
 *   → cobertura (asignados vs requeridos) por día×hora para la semana.
 *
 * El backend normaliza `weekStart` al primer día de la semana del tenant
 * (lun/dom según `companies.week_starts_on`) antes de iterar 7 días.
 */
@Controller('coverage')
export class CoverageController {
  constructor(
    private readonly coverageService: CoverageService,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  @Get()
  async getWeekCoverage(
    @CurrentCompany() companyId: string,
    @Query('weekStart') weekStart: string,
  ): Promise<CoverageReport> {
    if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new BadRequestException(
        `weekStart query param must be YYYY-MM-DD, got: ${weekStart}`,
      );
    }
    const weekStartsOn =
      await this.companyPreferences.getWeekStartsOn(companyId);
    return this.coverageService.getWeekCoverage(
      companyId,
      weekStart,
      weekStartsOn,
    );
  }
}
