import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
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
import { CloneScheduleDto } from '../dtos/clone-schedule.dto';
import {
  CloneScheduleCommand,
  CloneScheduleConflictError,
  type CloneScheduleResult,
} from '../../application/commands/clone-schedule.command';
import type { HybridScheduleResult } from '../../application/handlers/generate-hybrid-schedule.handler';
import type { CompanyScheduleAssignmentDTO } from '../../application/handlers/get-company-schedule.handler';
import { ScheduleGenerationLockedException } from '../../domain/services/schedule-generation-lock.service';
import { ScheduleGenerationDispatcher } from '../../application/jobs/schedule-generation-dispatcher.service';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';

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
    private readonly companyPreferences: CompanyPreferencesService,
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
        const weekStartsOn =
          await this.companyPreferences.getWeekStartsOn(companyId);
        const jobId = await this.scheduleDispatcher.enqueue({
          companyId,
          weekStart: dto.weekStart,
          weekStartsOn,
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
   * POST /schedules/clone
   *
   * Clona los assignments de `sourceWeekStart` a una o más target weeks.
   * Pre-checkea day_off_requests aprobados + absence_reports activas en
   * destinos; lo que choca se omite y se reporta en la response. Si las
   * targets ya tienen assignments y `overwrite=false` (default), tira
   * 409 sin tocar nada.
   *
   * No corre el solver/LLM — es una copia determinística + filtro de
   * conflictos. Para semanas vacías o continuidad simple es mucho más
   * rápido que regenerar (instantáneo + zero LLM cost).
   */
  @Post('clone')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.OK)
  // 10/min/IP — más permisivo que /generate (no cuesta tokens LLM)
  // pero capeado igual contra clicks accidentales repetidos.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async clone(
    @Body() dto: CloneScheduleDto,
    @CurrentCompany() companyId: string,
  ): Promise<CloneScheduleResult> {
    try {
      return await this.commandBus.execute(
        new CloneScheduleCommand(
          companyId,
          dto.sourceWeekStart,
          dto.targetWeekStarts,
          dto.overwrite ?? false,
          dto.employeeId ?? null,
          dto.dayOfWeek ?? null,
        ),
      );
    } catch (err) {
      if (err instanceof CloneScheduleConflictError) {
        throw new ConflictException({
          error: 'target_weeks_have_assignments',
          message: err.message,
          conflicts: err.conflicts,
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
