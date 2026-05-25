import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { Job } from 'pg-boss';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import {
  JOB_LLM_CREATE_RULE,
  JOB_LLM_UPDATE_RULE_TEXT,
  type LlmJobType,
} from '../../infrastructure/queue/job-names';
import type {
  CreateRuleJobPayload,
  UpdateRuleTextJobPayload,
} from '../../infrastructure/queue/job-types';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { CreateSemanticRuleCommand } from '../commands/create-semantic-rule.command';
import { UpdateSemanticRuleTextCommand } from '../commands/update-semantic-rule-text.command';

/**
 * LlmJobWorker
 *
 * Worker único para las 3 queues LLM. Cada queue tiene su handler
 * registrado con el CommandBus existente — no duplicamos lógica del
 * path síncrono, solo cambiamos el trigger (timer pg-boss en lugar
 * de HTTP request).
 *
 * Concurrency baja (1-2 por tipo): cada job hace varios LLM calls
 * serializados, más concurrencia satura el rate limit del provider.
 *
 * Failure path: si el handler lanza, el catch acá emite
 * `LlmJobFailed` con el mensaje. pg-boss no reintenta (retryLimit=0).
 */
@Injectable()
export class LlmJobWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(LlmJobWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly commandBus: CommandBus,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Gate: ENABLE_WORKERS=false desactiva los workers de LLM en este
    // proceso. Sin set, default enabled (compat con todo el setup viejo).
    if (process.env.ENABLE_WORKERS === 'false') {
      this.logger.log('ENABLE_WORKERS=false — LLM workers NOT registered');
      return;
    }
    if (!this.pgBoss.isEnabled()) {
      this.logger.warn('pg-boss disabled — LLM workers NOT registered');
      return;
    }
    const boss = this.pgBoss.getInstance();
    const concurrency = Math.max(
      1,
      Math.min(parseInt(process.env.LLM_WORKER_CONCURRENCY ?? '2', 10) || 2, 5),
    );
    const workOpts = {
      batchSize: concurrency,
      localConcurrency: concurrency,
      pollingIntervalSeconds: 1,
    };

    await boss.work<CreateRuleJobPayload>(
      JOB_LLM_CREATE_RULE,
      workOpts,
      async (jobs) => {
        await Promise.allSettled(
          jobs.map((job) =>
            this.runWithEvents(job, 'create_rule', async (p) => {
              const result = await this.commandBus.execute(
                new CreateSemanticRuleCommand(
                  p.companyId,
                  p.text,
                  p.priority as 1 | 2 | 3,
                  p.ruleType,
                  p.actorEmployeeId ?? undefined,
                  undefined,
                  null,
                  p.scopeType === 'branch' ? (p.scopeId ?? null) : null,
                  p.scopeType === 'department' ? (p.scopeId ?? null) : null,
                ),
              );
              return result;
            }),
          ),
        );
      },
    );

    await boss.work<UpdateRuleTextJobPayload>(
      JOB_LLM_UPDATE_RULE_TEXT,
      workOpts,
      async (jobs) => {
        await Promise.allSettled(
          jobs.map((job) =>
            this.runWithEvents(job, 'update_rule_text', async (p) => {
              return this.commandBus.execute(
                new UpdateSemanticRuleTextCommand(
                  p.ruleId,
                  p.companyId,
                  p.newText,
                ),
              );
            }),
          ),
        );
      },
    );

    this.logger.log(
      `LLM workers ready: ${JOB_LLM_CREATE_RULE}, ${JOB_LLM_UPDATE_RULE_TEXT} (concurrency=${concurrency})`,
    );
  }

  /**
   * Run handler + emit WS events. Catch a nivel job para que un fallo
   * no quede silencioso — el frontend muestra toast de error.
   */
  private async runWithEvents<P extends { companyId: string }>(
    job: Job<P>,
    type: LlmJobType,
    handler: (payload: P) => Promise<unknown>,
  ): Promise<void> {
    const { id: jobId, data: payload } = job;
    const companyId = payload.companyId;
    try {
      const result = await handler(payload);
      this.notificationsGateway.notifyLlmJobCompleted(
        companyId,
        jobId,
        type,
        result,
      );
      this.logger.log(`Job ${jobId} (${type}) completed`);
    } catch (err) {
      const message = (err as Error).message ?? 'Unknown error';
      this.notificationsGateway.notifyLlmJobFailed(
        companyId,
        jobId,
        type,
        message,
      );
      this.logger.error(
        `Job ${jobId} (${type}) failed: ${message}`,
        (err as Error).stack,
      );
      // No re-throw — el retryLimit=0 ya garantiza no reintentar y
      // queremos que el WS event sea la única señal de fallo.
    }
  }
}
