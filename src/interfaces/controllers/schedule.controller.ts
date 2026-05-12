import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GenerateHybridScheduleCommand } from '../../application/commands/generate-hybrid-schedule.command';
import { GetCompanyScheduleQuery } from '../../application/queries/get-company-schedule.query';
import { GenerateScheduleDto } from '../dtos/generate-schedule.dto';
import type { HybridScheduleResult } from '../../application/handlers/generate-hybrid-schedule.handler';
import type { CompanyScheduleAssignmentDTO } from '../../application/handlers/get-company-schedule.handler';
import { ScheduleGenerationLockedException } from '../../domain/services/schedule-generation-lock.service';
import { ScheduleGenerationDispatcher } from '../../application/jobs/schedule-generation-dispatcher.service';

/**
 * Parsea el header Accept-Language y devuelve un código de 2 letras
 * que el handler entiende ('en' | 'es'). Sin header válido → 'en'
 * (idioma canónico del sistema). Acepta formatos típicos como
 * "es-AR,es;q=0.9,en;q=0.8" → toma "es".
 */
function parseAcceptLanguage(header?: string): string {
  if (!header) return 'en';
  const first = header.split(',')[0]?.trim().toLowerCase();
  if (!first) return 'en';
  const code = first.split('-')[0];
  return code === 'es' ? 'es' : 'en';
}

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
  // 3/min/IP — la generación cuesta tokens LLM reales. Manager
  // normal dispara 1-2 veces por día; protege contra accidental
  // loops o intentional abuse.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async generate(
    @Body() dto: GenerateScheduleDto,
    @CurrentCompany() companyId: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<HybridScheduleResult | { jobId: string; status: 'queued' }> {
    const useAsync = process.env.USE_ASYNC_SCHEDULE_GEN === 'true';
    // Locale del request — el frontend pasa Accept-Language acorde al
    // i18n state. Default 'en' (idioma canónico del sistema). El
    // handler usa esto para construir explanation + warnings en el
    // idioma del manager.
    const locale = parseAcceptLanguage(acceptLanguage);

    if (useAsync) {
      // Path async (Fase 1): encola y devuelve 202 + jobId. El cliente
      // hace polling a /jobs/:id para ver el resultado.
      try {
        const jobId = await this.scheduleDispatcher.enqueue({
          companyId,
          weekStart: dto.weekStart,
          shiftTemplateId: dto.shiftTemplateId,
          departmentId: dto.departmentId,
          locale,
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
          locale,
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
    @CurrentCompany() companyId: string,
    @Query('departmentId') departmentId?: string,
    @Query('employeeId') employeeId?: string,
  ): Promise<CompanyScheduleAssignmentDTO[]> {
    return this.queryBus.execute(
      new GetCompanyScheduleQuery(
        companyId,
        weekStart,
        departmentId,
        employeeId,
      ),
    );
  }
}
