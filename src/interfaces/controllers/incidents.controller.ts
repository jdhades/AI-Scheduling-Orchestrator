import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateIncidentCommand } from '../../application/commands/create-incident.command';
import { RejectIncidentCommand } from '../../application/commands/reject-incident.command';
import { ResolveIncidentCommand } from '../../application/commands/resolve-incident.command';
import { GetIncidentsQuery } from '../../application/queries/get-incidents.query';
import { GetIncidentByIdQuery } from '../../application/queries/get-incident-by-id.query';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
} from 'class-validator';
import type { IncidentStatus } from '../../domain/aggregates/incident.aggregate';
import { ManagerScopeService } from '../../application/services/manager-scope.service';
import { ApprovalShiftEnricher } from '../../application/services/approval-shift-enricher.service';

// TODO(dry): ISO_DATE está duplicado en ~8 controllers/dtos; extraer a un util
// compartido en un pass dedicado.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateIncidentDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  /** Mensaje libre del reportante; puede ir vacío. */
  @IsOptional()
  @IsString()
  message?: string;

  /** URL al archivo evidencia (imagen/PDF). Puede ir vacío en MVP. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  mediaUrl?: string;
}

/** El empleado reporta un incidente propio (sin permiso de manager). */
export class ReportIncidentDto {
  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  mediaUrl?: string;

  /** Día al que se refiere (YYYY-MM-DD). Puede ser pasado (informativo). */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'occurredOn must be YYYY-MM-DD' })
  occurredOn?: string;
}

export class RejectIncidentDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class ResolveIncidentDto {
  @IsString()
  @IsNotEmpty()
  details!: string;
}

/**
 * IncidentsController
 *
 * POST /incidents                         — crear un incident (wraps CreateIncidentCommand)
 * GET  /incidents?companyId=&employeeId=&status=
 *                                          — lista (filtros opcionales)
 * GET  /incidents/:id                     — obtener uno
 *
 * El pipeline completo (OCR → validación → auto-repair → resolución) se
 * activa vía los eventos del aggregate + consumers registrados. Este
 * controller cubre los endpoints del manager UI: crear + listar + ver.
 */
@Controller('incidents')
export class IncidentsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly managerScope: ManagerScopeService,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly shiftEnricher: ApprovalShiftEnricher,
  ) {}

  /** Agrega `shift` a cada incidente por (empleado, startDate) — como absence. */
  private async withShift(
    companyId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<unknown[]> {
    const pairs = rows
      .filter((r) => typeof r.startDate === 'string')
      .map((r) => ({
        employeeId: r.employeeId as string,
        date: r.startDate as string,
      }));
    const byKey = await this.shiftEnricher.byEmployeeDates(companyId, pairs);
    return rows.map((r) => ({
      ...r,
      shift:
        typeof r.startDate === 'string'
          ? (byKey.get(`${r.employeeId as string}|${r.startDate}`) ?? null)
          : null,
    }));
  }

  @Post()
  @Requires('incidents:manage')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateIncidentDto,
    @CurrentCompany() companyId: string,
  ): Promise<{ success: boolean }> {
    await this.commandBus.execute(
      new CreateIncidentCommand(
        companyId,
        dto.employeeId,
        dto.message ?? '',
        dto.mediaUrl ?? '',
      ),
    );
    return { success: true };
  }

  /** POST /incidents/report — el empleado reporta un incidente propio. */
  @Post('report')
  @HttpCode(HttpStatus.CREATED)
  async report(
    @Body() dto: ReportIncidentDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ success: boolean }> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    await this.commandBus.execute(
      new CreateIncidentCommand(
        companyId,
        user.employeeId,
        dto.message ?? '',
        dto.mediaUrl ?? '',
        dto.occurredOn ?? null,
      ),
    );
    return { success: true };
  }

  /** DELETE /:id — el empleado cancela su propio reporte mientras esté 'reported'. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!user?.employeeId) throw new ForbiddenException('No employee linked');
    const { data } = await this.supabase
      .from('incidents')
      .select('employee_id, status')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle<{ employee_id: string; status: string }>();
    if (!data) throw new NotFoundException(`Incident ${id} not found`);
    if (data.employee_id !== user.employeeId) {
      throw new ForbiddenException('Cannot cancel another employee report');
    }
    if (data.status !== 'reported') {
      throw new BadRequestException('Incident already in progress');
    }
    await this.supabase
      .from('incidents')
      .delete()
      .eq('company_id', companyId)
      .eq('id', id);
  }

  @Get()
  async list(
    @CurrentCompany() companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('managerEmployeeId') managerEmployeeId?: string,
  ): Promise<unknown[]> {
    const statusList = status
      ? (status.split(',').map((s) => s.trim()) as IncidentStatus[])
      : undefined;
    const rows = await this.queryBus.execute(
      new GetIncidentsQuery(companyId, {
        employeeId,
        status:
          statusList && statusList.length === 1 ? statusList[0] : statusList,
      }),
    );
    const visible = managerEmployeeId
      ? await (async () => {
          const scope = await this.managerScope.getEmployeeIdsForManager(
            companyId,
            managerEmployeeId,
          );
          return rows.filter((r: { employeeId: string }) =>
            scope.has(r.employeeId),
          );
        })()
      : rows;
    return this.withShift(companyId, visible as Array<Record<string, unknown>>);
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(new GetIncidentByIdQuery(id, companyId));
  }

  /**
   * POST /incidents/:id/reject
   * Aplicable desde cualquier estado excepto RESOLVED o REJECTED.
   */
  @Post(':id/reject')
  @Requires('incidents:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectIncidentDto,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new RejectIncidentCommand(id, companyId, dto.reason),
    );
  }

  /**
   * POST /incidents/:id/resolve
   * Requiere estado REPLACEMENT_ASSIGNED | VALIDATED | REPAIR_IN_PROGRESS.
   */
  @Post(':id/resolve')
  @Requires('incidents:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new ResolveIncidentCommand(id, companyId, dto.details),
    );
  }
}
