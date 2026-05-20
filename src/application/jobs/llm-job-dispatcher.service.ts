import { Injectable, Logger } from '@nestjs/common';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import {
  LLM_JOB_QUEUE_BY_TYPE,
  type LlmJobType,
} from '../../infrastructure/queue/job-names';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';

/**
 * LlmJobDispatcher
 *
 * Encola jobs LLM en su queue correspondiente y emite el WS event
 * `LlmJobStarted` para que el frontend pinte el banner "procesando"
 * inmediatamente (sin esperar a que el worker pickee el job).
 *
 * El worker (LlmJobWorker) dispara `LlmJobCompleted` / `LlmJobFailed`
 * al terminar.
 */
@Injectable()
export class LlmJobDispatcher {
  private readonly logger = new Logger(LlmJobDispatcher.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  /**
   * Encola un job LLM. Devuelve el `jobId` que pg-boss asigna —
   * el frontend lo persiste en el store local para matchear los WS
   * events que llegan después.
   *
   * `companyId` es obligatorio para que el WS event llegue al tenant
   * correcto. `label` es un texto opcional (ej. el `text` de la regla)
   * para que el banner muestre algo más útil que "procesando…".
   */
  async enqueue<P extends { companyId: string }>(
    type: LlmJobType,
    payload: P,
    opts?: { label?: string },
  ): Promise<string> {
    if (!this.pgBoss.isEnabled()) {
      throw new Error(
        'pg-boss not enabled (DATABASE_URL missing). LLM async path unavailable.',
      );
    }
    const queueName = LLM_JOB_QUEUE_BY_TYPE[type];
    const boss = this.pgBoss.getInstance();
    const jobId = await boss.send(queueName, payload as unknown as object);
    if (!jobId) {
      throw new Error(`Failed to enqueue job ${queueName}`);
    }

    this.notificationsGateway.notifyLlmJobStarted(
      payload.companyId,
      jobId,
      type,
      opts?.label,
    );

    this.logger.log(
      `Enqueued job=${jobId} ${queueName} company=${payload.companyId}`,
    );
    return jobId;
  }
}
