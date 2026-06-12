import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateIncidentCommand } from '../../application/commands/create-incident.command';
import { RejectIncidentCommand } from '../../application/commands/reject-incident.command';
import { ResolveIncidentCommand } from '../../application/commands/resolve-incident.command';
import { GetIncidentsQuery } from '../../application/queries/get-incidents.query';
import { GetIncidentByIdQuery } from '../../application/queries/get-incident-by-id.query';
import { IsNotEmpty, IsOptional, IsString, IsUrl, Matches } from 'class-validator';
import type { IncidentStatus } from '../../domain/aggregates/incident.aggregate';
import { ManagerScopeService } from '../../application/services/manager-scope.service';

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
  ) {}

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
    if (managerEmployeeId) {
      const scope = await this.managerScope.getEmployeeIdsForManager(
        companyId,
        managerEmployeeId,
      );
      return rows.filter((r) => scope.has(r.employeeId));
    }
    return rows;
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
