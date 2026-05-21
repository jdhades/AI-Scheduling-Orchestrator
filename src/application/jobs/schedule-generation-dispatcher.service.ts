import { Injectable, Logger } from '@nestjs/common';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import { JOB_SCHEDULE_GENERATE } from '../../infrastructure/queue/job-names';
import type { ScheduleGenerationJobPayload } from '../../infrastructure/queue/job-types';
import {
  ScheduleGenerationLockService,
  ScheduleGenerationLockedException,
} from '../../domain/services/schedule-generation-lock.service';

/**
 * ScheduleGenerationDispatcher
 *
 * Encola un job `schedule.generate` con `singletonKey =
 * gen:{companyId}:{weekStartMonday}`. La queue tiene policy
 * `'exclusive'` → si ya hay un job con esa key en estado queued/active,
 * `boss.send` devuelve `null`. En ese caso lanzamos
 * `ScheduleGenerationLockedException` (la misma que el path síncrono)
 * para que el caller la traduzca al user con la misma UX.
 *
 * Política confirmada: REJECT segundo request, no encola, no cancela.
 */
@Injectable()
export class ScheduleGenerationDispatcher {
  private readonly logger = new Logger(ScheduleGenerationDispatcher.name);

  constructor(private readonly pgBoss: PgBossService) {}

  /**
   * Enqueue + return job id, o lanza
   * `ScheduleGenerationLockedException` si ya hay uno en curso para
   * la misma (companyId, weekStart).
   */
  async enqueue(payload: ScheduleGenerationJobPayload): Promise<string> {
    if (!this.pgBoss.isEnabled()) {
      throw new Error(
        'pg-boss not enabled (DATABASE_URL missing). Cannot use async path.',
      );
    }
    const normalized = ScheduleGenerationLockService.toWeekStart(
      payload.weekStart,
      payload.weekStartsOn,
    );
    const singletonKey = `gen:${payload.companyId}:${normalized}`;

    const boss = this.pgBoss.getInstance();
    const jobId = await boss.send(
      JOB_SCHEDULE_GENERATE,
      payload as unknown as object,
      { singletonKey },
    );

    if (!jobId) {
      // Queue policy 'exclusive' rechazó el insert → ya hay uno en
      // curso. Lanzamos la misma excepción que el path síncrono así
      // el caller no tiene que distinguir.
      this.logger.log(
        `Rejected duplicate enqueue company=${payload.companyId} week=${normalized} (singletonKey=${singletonKey})`,
      );
      throw new ScheduleGenerationLockedException(
        payload.companyId,
        normalized,
        new Date().toISOString(),
        'queue',
      );
    }

    this.logger.log(
      `Enqueued job=${jobId} ${JOB_SCHEDULE_GENERATE} ` +
        `company=${payload.companyId} week=${normalized} source=${payload.source.type}`,
    );
    return jobId;
  }
}
