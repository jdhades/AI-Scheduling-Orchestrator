import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ABSENCE_REPORT_REPOSITORY,
  type IAbsenceReportRepository,
} from '../../domain/repositories/absence-report.repository';
import { AbsenceReport } from '../../domain/aggregates/absence-report.aggregate';

export class CreateAbsenceReportDto {
  employeeId!: string;
  assignmentId?: string | null;
  reason!: string;
  isUrgent?: boolean;
}

/**
 * AbsenceReportsController
 *
 * POST /absence-reports              — registrar una ausencia
 * GET  /absence-reports              — listar (filtros: employeeId, isUrgent, from)
 * GET  /absence-reports/:id          — obtener uno
 *
 * Sin DELETE / PATCH: un reporte de ausencia es un hecho histórico,
 * no se edita. Si fue reportado por error, se puede crear un nuevo
 * registro "de corrección" con reason apropiado.
 */
@Controller('absence-reports')
export class AbsenceReportsController {
  constructor(
    @Inject(ABSENCE_REPORT_REPOSITORY)
    private readonly repo: IAbsenceReportRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateAbsenceReportDto,
  ): Promise<object> {
    const report = AbsenceReport.create({
      id: randomUUID(),
      companyId,
      employeeId: dto.employeeId,
      assignmentId: dto.assignmentId ?? null,
      reason: dto.reason,
      isUrgent: dto.isUrgent ?? false,
    });
    await this.repo.save(report);
    return this.toDto(report);
  }

  @Get()
  async list(
    @Query('companyId') companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('isUrgent') isUrgent?: string,
    @Query('from') fromISO?: string,
  ): Promise<object[]> {
    const rows = await this.repo.findAllByCompany(companyId, {
      employeeId,
      isUrgent:
        isUrgent === undefined ? undefined : isUrgent === 'true',
      fromISO,
    });
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

  private toDto(r: AbsenceReport): object {
    return {
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      assignmentId: r.assignmentId,
      reason: r.reason,
      isUrgent: r.isUrgent,
      reportedAt: r.reportedAt.toISOString(),
    };
  }
}
