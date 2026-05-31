import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from './pg-boss.service';
import {
  JOB_SCHEDULE_GENERATE,
  JOB_SCHEDULE_GENERATE_DEAD,
  JOB_LLM_CREATE_POLICY,
  JOB_LLM_CREATE_RULE,
  JOB_LLM_UPDATE_RULE_TEXT,
  JOB_IMPORTS_EXTRACT,
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

    this.logger.log(
      `Queues ready: ${JOB_SCHEDULE_GENERATE} (exclusive, retry=0, expire=600s, dead→${JOB_SCHEDULE_GENERATE_DEAD})`,
    );

    // ─── LLM jobs ────────────────────────────────────────────────────
    // policy=standard (sin singletonKey — el mismo manager puede crear
    // 2 reglas distintas en paralelo). retryLimit=0 + expire=600s para
    // matchear schedule.generate. Sin dead-letter por ahora — failures
    // se reportan vía WS event LlmJobFailed.
    const llmQueues = [
      JOB_LLM_CREATE_RULE,
      JOB_LLM_UPDATE_RULE_TEXT,
      JOB_LLM_CREATE_POLICY,
    ];
    for (const queue of llmQueues) {
      await boss.createQueue(queue, {
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 600,
      });
    }
    this.logger.log(
      `LLM queues ready: ${llmQueues.join(', ')} (standard, retry=0, expire=600s)`,
    );

    // ─── Imports extract (Fase 3) ────────────────────────────────────
    // Vision LLM puede tardar 30-90s en archivos grandes; expire 900s
    // (15 min) para no matar jobs válidos. retry=0 igual que el resto
    // de LLM jobs — no queremos pagar tokens dos veces.
    await boss.createQueue(JOB_IMPORTS_EXTRACT, {
      policy: 'standard',
      retryLimit: 0,
      expireInSeconds: 900,
    });
    this.logger.log(
      `Imports extract queue ready: ${JOB_IMPORTS_EXTRACT} (standard, retry=0, expire=900s)`,
    );
  }
}
