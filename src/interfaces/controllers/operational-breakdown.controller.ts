import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  OperationalBreakdownService,
  type DepartmentBreakdownRow,
  type EmployeeBreakdownRow,
  type TemplateBreakdownRow,
  type CrossCuttingMetrics,
} from '../../domain/services/operational-breakdown.service';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';

/**
 * OperationalBreakdownController — drill-down KPIs por dimensión.
 *
 *   GET /insights/breakdown/departments?weekStarts=...
 *   GET /insights/breakdown/employees?weekStarts=...
 *   GET /insights/breakdown/templates?weekStarts=...
 *   GET /insights/breakdown/cross-cutting?weekStarts=...
 *
 * Cada endpoint independiente: el frontend lazy-loadea on tab activate
 * para no pagar 4 queries cuando el manager solo mira una.
 */
@Controller('insights/breakdown')
export class OperationalBreakdownController {
  constructor(
    private readonly service: OperationalBreakdownService,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  @Get('departments')
  async getDepartments(
    @CurrentCompany() companyId: string,
    @Query('weekStarts') weekStartsParam: string,
  ): Promise<DepartmentBreakdownRow[]> {
    const weekStarts = this._parseWeekStarts(weekStartsParam);
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    return this.service.byDepartment(companyId, weekStarts, weekStartsOn);
  }

  @Get('employees')
  async getEmployees(
    @CurrentCompany() companyId: string,
    @Query('weekStarts') weekStartsParam: string,
  ): Promise<EmployeeBreakdownRow[]> {
    const weekStarts = this._parseWeekStarts(weekStartsParam);
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    return this.service.byEmployee(companyId, weekStarts, weekStartsOn);
  }

  @Get('templates')
  async getTemplates(
    @CurrentCompany() companyId: string,
    @Query('weekStarts') weekStartsParam: string,
  ): Promise<TemplateBreakdownRow[]> {
    const weekStarts = this._parseWeekStarts(weekStartsParam);
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    return this.service.byTemplate(companyId, weekStarts, weekStartsOn);
  }

  @Get('cross-cutting')
  async getCrossCutting(
    @CurrentCompany() companyId: string,
    @Query('weekStarts') weekStartsParam: string,
  ): Promise<CrossCuttingMetrics> {
    const weekStarts = this._parseWeekStarts(weekStartsParam);
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    return this.service.crossCutting(companyId, weekStarts, weekStartsOn);
  }

  private _parseWeekStarts(param: string): string[] {
    if (!param) {
      throw new BadRequestException(
        'weekStarts query param requerido (CSV de YYYY-MM-DD)',
      );
    }
    const parts = param.split(',').map((s) => s.trim());
    for (const p of parts) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p)) {
        throw new BadRequestException(
          `weekStarts contiene valor inválido: "${p}" (esperado YYYY-MM-DD)`,
        );
      }
    }
    return parts;
  }
}
