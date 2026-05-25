import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from './pg-boss.service';
import {
  JOB_SCHEDULE_GENERATE,
  JOB_SCHEDULE_GENERATE_DEAD,
  JOB_LLM_CREATE_RULE,
  JOB_LLM_UPDATE_RULE_TEXT,
} from './job-names';

/**
 * QueueBootstrapService
 *
 * Crea/configura las queues que la app espera al arrancar. pg-boss
 * permite enviar jobs sin pre-crear la queue (la crea con policy
 * `standard`), pero acá necesitamos `exclusive` + dead-letter, así
 * que las creamos explícitamente.
 *
 * Idempotente: `createQueue` no falla si ya existe.
 *
 * Configuración de `schedule.generate`:
 *   - policy: 'exclusive' → con `singletonKey`, máximo 1 job por
 *     (companyId, weekStart) en estado queued+active. El segundo
 *     `send` devuelve null → REJECT (política confirmada por el
 *     usuario, no encolar ni cancelar).
 *   - retryLimit: 0 → un solo intento. Sin retry — el LLM gasta
 *     tokens reales en cada attempt y un retry automático no resuelve
 *     fallas determinísticas (rules conflictivas, slots imposibles).
 *     Si falla, va directo a dead-letter y el manager decide.
 *   - expireInSeconds: 600 → timeout duro 10 min por intento. Antes
 *     era 180s pero generaciones con prompts grandes / LLM lento se
 *     iban a 200-300s y el expire mataba runs válidos. 10 min cubre
 *     el caso peor sin acoplar a la red.
 *   - deadLetter: 'schedule.generate.dead' → al fallar/expirar,
 *     el payload se copia a esa queue y un worker dedicado notifica
 *     al manager.
 */
@Injectable()
export class QueueBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(QueueBootstrapService.name);

  constructor(private readonly pgBoss: PgBossService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pgBoss.isEnabled()) {
      this.logger.warn(
        'pg-boss disabled — queues not created. Set DATABASE_URL to enable.',
      );
      return;
    }
    // Asegurar que pg-boss terminó start() (createSchema + migrate)
    // antes de crear queues. Crítico porque NestJS corre los onModuleInit
    // del mismo módulo en Promise.all (paralelo); sin este await, la
    // primera createQueue puede llegar antes de que exista el schema.
    await this.pgBoss.ready();
    const boss = this.pgBoss.getInstance();

    // Dead-letter queue — standard policy, sin retries (última parada
    // antes de loguear y notificar al manager).
    await boss.createQueue(JOB_SCHEDULE_GENERATE_DEAD, {
      policy: 'standard',
      retryLimit: 0,
    });

    // Main queue — exclusive + retryLimit=0 + expire=10min + dead-letter.
    await boss.createQueue(JOB_SCHEDULE_GENERATE, {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 600,
      deadLetter: JOB_SCHEDULE_GENERATE_DEAD,
    });

    // pg-boss v12 — `createQueue` es idempotente y NO actualiza
    // retry_limit / expire_seconds si la queue ya existe; su API
    // pública `updateQueue` solo soporta `deadLetter`. Para deploys
    // existentes con config vieja, sincronizamos vía SQL directo.
    // Idempotente — si los valores ya matchean, el UPDATE es no-op.
    await this.syncQueueConfig(JOB_SCHEDULE_GENERATE, 0, 600);

    this.logger.log(
      `Queues ready: ${JOB_SCHEDULE_GENERATE} (exclusive, retry=0, expire=600s, dead→${JOB_SCHEDULE_GENERATE_DEAD})`,
    );

    // ─── LLM jobs ────────────────────────────────────────────────────
    // policy=standard (sin singletonKey — el mismo manager puede crear
    // 2 reglas distintas en paralelo). retryLimit=0 + expire=600s para
    // matchear schedule.generate. Sin dead-letter por ahora — failures
    // se reportan vía WS event LlmJobFailed.
    for (const queue of [JOB_LLM_CREATE_RULE, JOB_LLM_UPDATE_RULE_TEXT]) {
      await boss.createQueue(queue, {
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 600,
      });
      await this.syncQueueConfig(queue, 0, 600);
    }
    this.logger.log(
      `LLM queues ready: ${JOB_LLM_CREATE_RULE}, ${JOB_LLM_UPDATE_RULE_TEXT} (standard, retry=0, expire=600s)`,
    );
  }

  /**
   * Update directo a `pgboss.queue` para forzar retry_limit /
   * expire_seconds aún si la queue ya existía con valores distintos.
   * pg-boss no expone esto en su API pública.
   */
  private async syncQueueConfig(
    name: string,
    retryLimit: number,
    expireSeconds: number,
  ): Promise<void> {
    try {
      const boss = this.pgBoss.getInstance() as unknown as {
        db: {
          executeSql: (
            sql: string,
            params: unknown[],
          ) => Promise<{ rowCount: number }>;
        };
      };
      await boss.db.executeSql(
        `UPDATE pgboss.queue SET retry_limit = $1, expire_seconds = $2 WHERE name = $3`,
        [retryLimit, expireSeconds, name],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to sync queue config for ${name}: ${(err as Error).message}`,
      );
    }
  }
}
