import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { ScheduleGenerationDispatcher } from '../../application/jobs/schedule-generation-dispatcher.service';

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
    private readonly scheduleDispatcher: ScheduleGenerationDispatcher,
  ) {}

  /**
   * POST /schedules/generate
   *
   * Genera el horario completo con el motor employee-first
   * (`WeekScheduleBuilder`) + el LLM como proveedor de líneas.
   */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generate(
    @Body() dto: GenerateScheduleDto,
    @Query('companyId') companyId: string,
  ): Promise<HybridScheduleResult | { jobId: string; status: 'queued' }> {
    const useAsync = process.env.USE_ASYNC_SCHEDULE_GEN === 'true';

    if (useAsync) {
      // Path async (Fase 1): encola y devuelve 202 + jobId. El cliente
      // hace polling a /jobs/:id para ver el resultado.
      try {
        const jobId = await this.scheduleDispatcher.enqueue({
          companyId,
          weekStart: dto.weekStart,
          shiftTemplateId: dto.shiftTemplateId,
          departmentId: dto.departmentId,
          locale: 'es',
          source: { type: 'http' },
        });
        return { jobId, status: 'queued' };
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

    // Path síncrono (Fase 0): handler corre inline con lock interno.
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
