import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { I18nService } from 'nestjs-i18n';
import type { Job } from 'pg-boss';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import { JobCancellationRegistry } from '../../infrastructure/queue/job-cancellation.registry';
import {
  JOB_SCHEDULE_GENERATE,
} from '../../infrastructure/queue/job-names';
import type { ScheduleGenerationJobPayload } from '../../infrastructure/queue/job-types';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
import type { HybridScheduleResult } from '../../application/handlers/generate-hybrid-schedule.handler';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from '../../domain/services/notification.service';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { ScheduleGenerationRunsService } from '../../domain/services/schedule-generation-runs.service';
import { LLMUsageLogger } from '../../infrastructure/observability/llm-usage-logger.service';

/**
 * ScheduleGenerationJobHandler
 *
 * Worker que procesa jobs `schedule.generate` desde pg-boss. Reusa
 * el `GenerateHybridScheduleCommand` existente vía CommandBus, así
 * toda la lógica del path síncrono (lock Fase 0, runGeneration,
 * fairness, NotificationsGateway WS) sigue funcionando idéntica.
 *
 * Pre/post:
 *   - Antes: el dispatcher encoló con `singletonKey` → garantía de
 *     que no hay otra corriendo para la misma (companyId, weekStart).
 *     El lock interno del handler solo confirma; nunca debería chocar.
 *   - Después (success): si el origen es WhatsApp, Twilio outbound
 *     con explanation + warnings. Si es HTTP, el cliente se entera
 *     vía polling de /jobs/:id (Fase 2).
 *   - Después (failure): se re-lanza la excepción. pg-boss reintenta
 *     según `retryLimit` (queue config = 1). Al exhaustar, copia el
 *     payload a la dead-letter queue → otro handler notifica.
 */
@Injectable()
export class ScheduleGenerationJobHandler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleGenerationJobHandler.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly commandBus: CommandBus,
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
    private readonly i18n: I18nService,
    private readonly cancellationRegistry: JobCancellationRegistry,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly runsService: ScheduleGenerationRunsService,
    private readonly usageLogger: LLMUsageLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Gate: ENABLE_WORKERS=false desactiva todos los workers en este
    // proceso. Útil cuando querés correr el orchestrator solo como API
    // (sin consumir jobs) y dejar el procesamiento a otro proceso/host.
    // Default = enabled — sin variable, todo funciona como siempre.
    if (process.env.ENABLE_WORKERS === 'false') {
      this.logger.log(
        `ENABLE_WORKERS=false — ${JOB_SCHEDULE_GENERATE} worker NOT registered`,
      );
      return;
    }
    if (!this.pgBoss.isEnabled()) {
      this.logger.warn(
        `pg-boss disabled — ${JOB_SCHEDULE_GENERATE} worker NOT registered`,
      );
      return;
    }
    const boss = this.pgBoss.getInstance();
    // Concurrency configurable vía env. Default 2 — permite que
    // empresa A esté generando con LLM mientras empresa B arranca
    // sin esperar 2-3 min (caso multi-tenant discutido al final del
    // sprint dashboard). El cap razonable es 3-4: cada job hace
    // varios calls al LLM serializados internamente, y DashScope
    // tiene rate-limit por cuenta — más concurrencia satura.
    const concurrency = Math.max(
      1,
      Math.min(parseInt(process.env.SCHEDULE_WORKER_CONCURRENCY ?? '2', 10) || 2, 10),
    );
    await boss.work<ScheduleGenerationJobPayload>(
      JOB_SCHEDULE_GENERATE,
      {
        // batchSize        = jobs fetched per poll
        // localConcurrency = workers que corren en paralelo en este nodo
        batchSize: concurrency,
        localConcurrency: concurrency,
        pollingIntervalSeconds: 1,
      },
      async (jobs) => {
        // localConcurrency arma N workers en paralelo en este nodo, cada
        // uno corriendo este handler con un job a la vez. allSettled
        // protege la invocación si por algún motivo `jobs` trae >1.
        await Promise.allSettled(jobs.map((job) => this._handleJob(job)));
      },
    );
    this.logger.log(
      `Worker registered for ${JOB_SCHEDULE_GENERATE} (concurrency=${concurrency})`,
    );
  }

  private async _handleJob(
    job: Job<ScheduleGenerationJobPayload>,
  ): Promise<void> {
    const payload = job.data;
    const startedAt = Date.now();
    this.logger.log(
      `Processing job=${job.id} ${JOB_SCHEDULE_GENERATE} ` +
        `company=${payload.companyId} week=${payload.weekStart} ` +
        `source=${payload.source.type}`,
    );

    // Phase 4 — broadcast del pickup (created/retry → active). El
    // front cierra el "queued" del banner y abre el "active" sin
    // esperar el polling. Idempotente: si pg-boss reintenta, este
    // emit se repite (front re-invalida la query, no es harmful).
    this.notificationsGateway.notifyScheduleGenerationStarted(
      payload.companyId,
      payload.weekStart,
      job.id,
    );

    // Fase 3 — registramos un AbortController propio. pg-boss v12 NO
    // aborta job.signal cuando se llama boss.cancel() (solo cambia el
    // state en BD), así que necesitamos nuestro propio canal. El
    // controller invoca registry.abort(jobId) después de boss.cancel().
    const cancelSignal = this.cancellationRegistry.register(job.id);

    let result: HybridScheduleResult;
    try {
      // F.6 — withContext envuelve el execute para que cada llamada
      // LLM dentro del scope quede etiquetada con operation +
      // companyId + jobId en `llm_usage_log`.
      result = await this.usageLogger.withContext(
        {
          operation: 'schedule_generation',
          companyId: payload.companyId,
          jobId: job.id,
        },
        () =>
          this.commandBus.execute<
            GenerateHybridScheduleCommand,
            HybridScheduleResult
          >(
            new GenerateHybridScheduleCommand(
              payload.companyId,
              payload.weekStart,
              undefined,
              payload.shiftTemplateId,
              payload.locale,
              payload.departmentId,
              cancelSignal,
              // Phase 4 — lockToken = jobId. Permite que el cancel del
              // controller pre-libere el lock con la misma key sin pisar
              // a un job posterior que lo retome.
              job.id,
            ),
          ),
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      if (cancelSignal.aborted) {
        this.logger.log(`Job=${job.id} cancelled by user after ${ms}ms`);
        // F.6 — record cancelled run para que aparezca en el histórico.
        await this.runsService.record({
          companyId: payload.companyId,
          weekStart: payload.weekStart,
          jobId: job.id,
          status: 'cancelled',
          source: payload.source.type,
          durationMs: ms,
        });
        throw err; // pg-boss respeta state='cancelled' (ya seteado por boss.cancel)
      }
      this.logger.error(
        `Job=${job.id} failed after ${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err; // pg-boss decide si reintentar o mandar a dead-letter
    } finally {
      this.cancellationRegistry.unregister(job.id);
    }

    const ms = Date.now() - startedAt;
    this.logger.log(
      `Job=${job.id} success in ${ms}ms — ${result.assignmentsCount} assignments, ${result.unfilledShiftsCount} unfilled`,
    );

    // F.6 — record completed run con métricas LLM + warnings.
    await this.runsService.record({
      companyId: payload.companyId,
      weekStart: payload.weekStart,
      jobId: job.id,
      status: 'completed',
      source: payload.source.type,
      durationMs: ms,
      assignmentsCount: result.assignmentsCount,
      unfilledCount: result.unfilledShiftsCount,
      llm: result.llmUsage ?? null,
      explanation: result.explanation,
      warnings: result.warnings,
    });

    // Notificar al originador (solo WhatsApp por ahora; HTTP usa polling).
    if (payload.source.type === 'whatsapp') {
      const message = this._formatSuccessReply(
        result,
        payload.locale ?? 'es',
        payload.weekStart,
      );
      try {
        await this.notificationService.sendWhatsApp(
          payload.source.from,
          message,
        );
      } catch (sendErr) {
        // Falla de notificación NO debe marcar el job como fallido —
        // los assignments ya están persistidos. Solo logueamos.
        this.logger.warn(
          `Job=${job.id} success but Twilio outbound failed: ${(sendErr as Error).message}`,
        );
      }
    }
  }

  private _formatSuccessReply(
    result: HybridScheduleResult,
    locale: string,
    weekStart: string,
  ): string {
    void weekStart;
    const lines = [result.explanation];
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push(this.i18n.t('bot.schedule.warnings_header', { lang: locale }));
      for (const w of result.warnings) lines.push(`• ${w}`);
    }
    return lines.join('\n');
  }
}
