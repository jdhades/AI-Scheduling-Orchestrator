import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsOptional, IsString, Matches } from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import {
  FAIRNESS_HISTORY_REPOSITORY,
  type IFairnessHistoryRepository,
} from '../../domain/repositories/fairness-history.repository';
import { ScheduleGenerationDispatcher } from '../../application/jobs/schedule-generation-dispatcher.service';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';
import { ScheduleGenerationLockedException } from '../../domain/services/schedule-generation-lock.service';

export class ForceGenerateDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart must be YYYY-MM-DD' })
  @IsString()
  weekStart!: string;

  @IsOptional()
  @IsString()
  shiftTemplateId?: string;
}

/**
 * AdminTenantOpsController — acciones operacionales puntuales que el
 * soporte ejecuta sobre un tenant. Aislado del CRUD de subscription/LLM
 * para que las rutas destructivas vivan en un controller acotado.
 *
 *   POST /admin/companies/:id/reset-onboarding   → onboarded_at = NULL
 *   POST /admin/companies/:id/reset-fairness     → wipe del historial
 *   POST /admin/companies/:id/force-generate     → libera lock + enqueue
 *
 * Todas las acciones devuelven 204 (No Content) excepto force-generate
 * que devuelve el jobId que se enqueueó.
 */
@Controller('admin/companies')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminTenantOpsController {
  private readonly logger = new Logger(AdminTenantOpsController.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepo: IFairnessHistoryRepository,
    private readonly scheduleDispatcher: ScheduleGenerationDispatcher,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  /**
   * Re-abre el wizard de onboarding para el tenant. El RootResolver del
   * frontend lee `profile.company.onboardedAt`; si es NULL redirige a
   * /onboarding. Útil cuando un tenant quedó en mitad del wizard con
   * datos basura.
   */
  @Post(':id/reset-onboarding')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetOnboarding(@Param('id') id: string): Promise<void> {
    await this._ensureCompanyExists(id);
    const { error } = await this.supabase
      .from('companies')
      .update({ onboarded_at: null })
      .eq('id', id);
    if (error) throw new BadRequestException(error.message);
    this.logger.log(`[admin] reset onboarding company=${id}`);
  }

  /**
   * Borra el historial de fairness del tenant. El siguiente generate
   * arranca desde cero (todos los empleados con score base). Útil
   * cuando el historial está corrupto o un tenant cambió drásticamente
   * de roster.
   */
  @Post(':id/reset-fairness')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetFairness(@Param('id') id: string): Promise<void> {
    await this._ensureCompanyExists(id);
    await this.fairnessRepo.deleteAllByCompany(id);
    this.logger.log(`[admin] reset fairness company=${id}`);
  }

  /**
   * Encola un generate para (companyId, weekStart) bypaseando locks
   * existentes. Si había un lock activo lo borra primero — usar SOLO
   * cuando estás seguro de que el lock es huérfano (worker crashed).
   *
   * Devuelve el jobId que pg-boss asignó. El tenant se va a enterar
   * via WS si tiene la página abierta.
   */
  @Post(':id/force-generate')
  @HttpCode(HttpStatus.OK)
  async forceGenerate(
    @Param('id') id: string,
    @Body() body: ForceGenerateDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    await this._ensureCompanyExists(id);

    // Limpiar lock previo si existe (force = bypass exclusivo).
    const { error: lockErr } = await this.supabase
      .from('schedule_generation_locks')
      .delete()
      .eq('company_id', id)
      .eq('week_start', body.weekStart);
    if (lockErr) throw new BadRequestException(lockErr.message);

    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(id);

    try {
      const jobId = await this.scheduleDispatcher.enqueue({
        companyId: id,
        weekStart: body.weekStart,
        weekStartsOn,
        shiftTemplateId: body.shiftTemplateId,
        // El union ScheduleGenerationJobSource solo tiene http|whatsapp.
        // Tratamos force-generate como http: el worker emite por WS al
        // tenant. Si en el futuro queremos distinguir admin-initiated
        // del audit, extender el union con un 'admin_force' branch.
        source: { type: 'http' },
        locale: 'en',
      });
      this.logger.log(
        `[admin] force-generate enqueued company=${id} week=${body.weekStart} jobId=${jobId}`,
      );
      return { jobId, status: 'queued' };
    } catch (err) {
      // pg-boss singletonKey igual rechazó (race con un worker que
      // levantó el job antes que borráramos el lock). Devolvemos 409
      // con info para que el admin reintente después.
      if (err instanceof ScheduleGenerationLockedException) {
        throw new BadRequestException({
          error: 'generation_in_progress',
          companyId: err.companyId,
          weekStart: err.weekStart,
          since: err.acquiredAt,
        });
      }
      throw err;
    }
  }

  private async _ensureCompanyExists(id: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('companies')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Company not found');
  }
}
