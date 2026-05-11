import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import type { Job } from 'pg-boss';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import { JOB_SCHEDULE_GENERATE_DEAD } from '../../infrastructure/queue/job-names';
import type { ScheduleGenerationJobPayload } from '../../infrastructure/queue/job-types';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from '../../domain/services/notification.service';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { ScheduleGenerationRunsService } from '../../domain/services/schedule-generation-runs.service';

/**
 * ScheduleGenerationDeadletterHandler
 *
 * Worker dedicado a la dead-letter queue (`schedule.generate.dead`).
 * pg-boss copia acá los jobs de `schedule.generate` que exhaustaron
 * los retries (retryLimit=1 → 2 intentos totales fallidos).
 *
 * Responsabilidad única: notificar al manager y loguear. NO
 * reintenta, NO escribe a BD, NO toca el lock (la `release` del
 * handler ya corrió en cada intento via finally).
 */
@Injectable()
export class ScheduleGenerationDeadletterHandler
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(
    ScheduleGenerationDeadletterHandler.name,
  );

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly i18n: I18nService,
    private readonly runsService: ScheduleGenerationRunsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pgBoss.isEnabled()) return;
    const boss = this.pgBoss.getInstance();
    await boss.work<ScheduleGenerationJobPayload>(
      JOB_SCHEDULE_GENERATE_DEAD,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          await this._handleDeadletter(job);
        }
      },
    );
    this.logger.log(`Worker registered for ${JOB_SCHEDULE_GENERATE_DEAD}`);
  }

  private async _handleDeadletter(
    job: Job<ScheduleGenerationJobPayload>,
  ): Promise<void> {
    const payload = job.data;
    this.logger.warn(
      `Dead-letter received job=${job.id} ` +
        `company=${payload.companyId} week=${payload.weekStart} ` +
        `source=${payload.source.type} — notifying originator`,
    );

    // F.6 — record failed run para el histórico. duration es desconocido
    // en este punto (pg-boss no lo expone fácilmente al deadletter), así
    // que pasamos 0 — el campo es informativo, no se filtra por él.
    await this.runsService.record({
      companyId: payload.companyId,
      weekStart: payload.weekStart,
      jobId: job.id,
      status: 'failed',
      source: payload.source.type,
      durationMs: 0,
      errorMessage: 'Job exhausted retries (dead-letter)',
    });

    // WS broadcast — el dashboard muestra toast de error sin que el
    // manager tenga que estar en /generate.
    this.notificationsGateway.notifyScheduleGenerationFailed(
      payload.companyId,
      payload.weekStart,
    );

    // Outbound Twilio si el job se originó por WhatsApp.
    if (payload.source.type === 'whatsapp') {
      const message = this.i18n.t('bot.schedule.generation_failed', {
        lang: payload.locale ?? 'es',
        args: { weekStart: payload.weekStart },
      });
      try {
        await this.notificationService.sendWhatsApp(
          payload.source.from,
          message,
        );
      } catch (err) {
        this.logger.error(
          `Dead-letter notification failed for job=${job.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
