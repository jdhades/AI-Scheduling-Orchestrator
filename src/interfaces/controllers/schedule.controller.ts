import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GenerateHybridScheduleCommand } from '../../application/commands/generate-hybrid-schedule.command';
import { GetCompanyScheduleQuery } from '../../application/queries/get-company-schedule.query';
import { GenerateScheduleDto } from '../dtos/generate-schedule.dto';
import type { HybridScheduleResult } from '../../application/handlers/generate-hybrid-schedule.handler';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

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
    return this.commandBus.execute(
      new GenerateHybridScheduleCommand(
        companyId,
        dto.weekStart,
        dto.maxFairnessDeviation,
        dto.shiftTemplateId,
        undefined,
        dto.departmentId,
      ),
    );
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
  ): Promise<ShiftAssignment[]> {
    return this.queryBus.execute(
      new GetCompanyScheduleQuery(companyId, weekStart),
    );
  }
}
