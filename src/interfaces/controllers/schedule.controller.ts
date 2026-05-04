import {
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GenerateHybridScheduleCommand } from '../../application/commands/generate-hybrid-schedule.command';
import { GetCompanyScheduleQuery } from '../../application/queries/get-company-schedule.query';
import { GenerateScheduleDto } from '../dtos/generate-schedule.dto';
import type { HybridScheduleResult } from '../../application/handlers/generate-hybrid-schedule.handler';
import type { CompanyScheduleAssignmentDTO } from '../../application/handlers/get-company-schedule.handler';
import { ScheduleGenerationLockedException } from '../../domain/services/schedule-generation-lock.service';

/**
 * ScheduleController
 *
 * Endpoints del motor de scheduling:
 *   POST /schedules/generate       — Genera el horario de la semana
 *   GET  /schedules                — Consulta el horario de una semana
 */
@Controller('schedules')
export class ScheduleController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * POST /schedules/generate
   *
   * Genera el horario completo con el motor employee-first
   * (`WeekScheduleBuilder`) + el LLM como proveedor de líneas.
   */
  @Post('generate')
  async generate(
    @Body() dto: GenerateScheduleDto,
    @Query('companyId') companyId: string,
  ): Promise<HybridScheduleResult> {
    try {
      return await this.commandBus.execute(
        new GenerateHybridScheduleCommand(
          companyId,
          dto.weekStart,
          dto.maxFairnessDeviation,
          dto.shiftTemplateId,
          undefined,
          dto.departmentId,
        ),
      );
    } catch (err) {
      if (err instanceof ScheduleGenerationLockedException) {
        throw new ConflictException({
          error: 'generation_in_progress',
          companyId: err.companyId,
          weekStart: err.weekStart,
          since: err.acquiredAt,
          acquiredBy: err.acquiredBy,
        });
      }
      throw err;
    }
  }

  /**
   * GET /schedules?weekStart=2024-03-04
   *
   * Devuelve todas las asignaciones de turno de la empresa para la semana.
   */
  @Get()
  async getSchedule(
    @Query('weekStart') weekStart: string,
    @Query('companyId') companyId: string,
    @Query('departmentId') departmentId?: string,
  ): Promise<CompanyScheduleAssignmentDTO[]> {
    return this.queryBus.execute(
      new GetCompanyScheduleQuery(companyId, weekStart, departmentId),
    );
  }
}
