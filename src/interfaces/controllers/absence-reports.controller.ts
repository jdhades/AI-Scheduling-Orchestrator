import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  ABSENCE_REPORT_REPOSITORY,
  type IAbsenceReportRepository,
} from '../../domain/repositories/absence-report.repository';
import { AbsenceReport } from '../../domain/aggregates/absence-report.aggregate';
import { ManagerScopeService } from '../../application/services/manager-scope.service';
import { AbsenceReportCreator } from '../../domain/services/absence-report-creator.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// IDs validados como strings no vacíos (la seed data del proyecto usa
// formato UUID-shape no estricto RFC 4122 — @IsUUID los rechazaría).
export class CreateAbsenceReportDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  assignmentId?: string | null;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  /**
   * Phase 17.1 — período de la ausencia (YYYY-MM-DD). startDate default
   * = hoy si no llega; endDate default = startDate. Single-day si los
   * dos coinciden, multi-day si end > start.
   */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;

  /**
   * Solo flag de UI: el creator recalcula isUrgent inspeccionando los
   * assignments del range. Lo dejamos por compat con clientes que lo
   * mandan, pero el valor real lo decide el creator.
   */
  @IsOptional()
  @IsBoolean()
  isUrgent?: boolean;
}

/**
 * AbsenceReportsController
 *
 * POST   /absence-reports              — registrar una ausencia (Phase 17.2:
 *                                         delega en AbsenceReportCreator;
 *                                         dispara borrado de assignments
 *                                         del range + notificación al
 *                                         manager via event handler).
 * GET    /absence-reports              — listar (filtros: employeeId, isUrgent, from).
 * GET    /absence-reports/:id          — obtener uno.
 * DELETE /absence-reports/:id          — soft delete. NO restaura los
 *                                         assignments borrados (el manager
 *                                         regenera el slot si quiere).
 */
@Controller('absence-reports')
export class AbsenceReportsController {
  constructor(
    @Inject(ABSENCE_REPORT_REPOSITORY)
    private readonly repo: IAbsenceReportRepository,
    private readonly managerScope: ManagerScopeService,
    private readonly creator: AbsenceReportCreator,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateAbsenceReportDto,
  ): Promise<object> {
    const result = await this.creator.create({
      companyId,
      employeeId: dto.employeeId,
      reason: dto.reason,
      startDate: dto.startDate,
      endDate: dto.endDate,
      assignmentIdHint: dto.assignmentId ?? null,
    });
    // Phase 18.2 — el report puede ser null cuando todo el rango era
    // futuro sin assignments (solo se crearon rules). El frontend
    // refleja ambos casos: report puede no existir, pero rulesCreated
    // siempre informa qué se creó para el scheduler.
    return {
      report: result.report ? this.toDto(result.report) : null,
      deletedAssignmentIds: result.deletedAssignmentIds,
      rulesCreated: result.rulesCreated,
      isUrgent: result.isUrgent,
    };
  }

  @Get()
  async list(
    @Query('companyId') companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('isUrgent') isUrgent?: string,
    @Query('from') fromISO?: string,
    @Query('managerEmployeeId') managerEmployeeId?: string,
  ): Promise<object[]> {
    const rows = await this.repo.findAllByCompany(companyId, {
      employeeId,
      isUrgent:
        isUrgent === undefined ? undefined : isUrgent === 'true',
      fromISO,
    });
    if (managerEmployeeId) {
      const scope = await this.managerScope.getEmployeeIdsForManager(
        companyId,
        managerEmployeeId,
      );
      return rows
        .filter((r) => scope.has(r.employeeId))
        .map((r) => this.toDto(r));
    }
    return rows.map((r) => this.toDto(r));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<object> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`AbsenceReport ${id} not found`);
    return this.toDto(r);
  }

  /**
   * DELETE /absence-reports/:id?companyId=...
   *
   * Soft-delete del reporte. NO restaura assignments que se borraron
   * cuando el reporte se creó: si el manager lo necesita reemplazado,
   * regenera el slot con el bot de generación. Devuelve 204 NO_CONTENT.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<void> {
    const existing = await this.repo.findById(id, companyId);
    if (!existing) {
      throw new NotFoundException(`AbsenceReport ${id} not found`);
    }
    await this.repo.softDelete(id, companyId);
  }

  private toDto(r: AbsenceReport): object {
    return {
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      assignmentId: r.assignmentId,
      reason: r.reason,
      isUrgent: r.isUrgent,
      startDate: r.startDate,
      endDate: r.endDate,
      reportedAt: r.reportedAt.toISOString(),
    };
  }
}
