import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
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
import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';
import type { IncidentStatus } from '../../domain/aggregates/incident.aggregate';
import { ManagerScopeService } from '../../application/services/manager-scope.service';

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
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateIncidentDto,    @CurrentCompany() companyId: string,
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

  @Get()
  async list(    @CurrentCompany() companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('managerEmployeeId') managerEmployeeId?: string,
  ): Promise<unknown[]> {
    const statusList = status
      ? (status.split(',').map((s) => s.trim()) as IncidentStatus[])
      : undefined;
    const rows = (await this.queryBus.execute(
      new GetIncidentsQuery(companyId, {
        employeeId,
        status: statusList && statusList.length === 1 ? statusList[0] : statusList,
      }),
    )) as Array<{ employeeId: string }>;
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
    @Param('id') id: string,    @CurrentCompany() companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(new GetIncidentByIdQuery(id, companyId));
  }

  /**
   * POST /incidents/:id/reject
   * Aplicable desde cualquier estado excepto RESOLVED o REJECTED.
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectIncidentDto,    @CurrentCompany() companyId: string,
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
  @HttpCode(HttpStatus.NO_CONTENT)
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveIncidentDto,    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new ResolveIncidentCommand(id, companyId, dto.details),
    );
  }
}
