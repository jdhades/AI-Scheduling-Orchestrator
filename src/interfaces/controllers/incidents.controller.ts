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
import { GetIncidentsQuery } from '../../application/queries/get-incidents.query';
import { GetIncidentByIdQuery } from '../../application/queries/get-incident-by-id.query';
import type { IncidentStatus } from '../../domain/aggregates/incident.aggregate';

export class CreateIncidentDto {
  employeeId!: string;
  /** Mensaje libre del reportante; puede ir vacío. */
  message?: string;
  /** URL al archivo evidencia (imagen/PDF). Puede ir vacío en MVP. */
  mediaUrl?: string;
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateIncidentDto,
    @Headers('x-company-id') companyIdHeader: string,
    @Query('companyId') companyIdQuery?: string,
  ): Promise<{ success: boolean }> {
    const companyId = companyIdHeader || companyIdQuery || '';
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
  async list(
    @Headers('x-company-id') companyIdHeader: string,
    @Query('companyId') companyIdQuery?: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
  ): Promise<unknown[]> {
    const companyId = companyIdHeader || companyIdQuery || '';
    const statusList = status
      ? (status.split(',').map((s) => s.trim()) as IncidentStatus[])
      : undefined;
    return this.queryBus.execute(
      new GetIncidentsQuery(companyId, {
        employeeId,
        status: statusList && statusList.length === 1 ? statusList[0] : statusList,
      }),
    );
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Headers('x-company-id') companyIdHeader: string,
    @Query('companyId') companyIdQuery?: string,
  ): Promise<unknown> {
    const companyId = companyIdHeader || companyIdQuery || '';
    return this.queryBus.execute(new GetIncidentByIdQuery(id, companyId));
  }
}
