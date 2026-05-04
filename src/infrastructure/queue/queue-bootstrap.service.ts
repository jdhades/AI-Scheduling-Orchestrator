import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from './pg-boss.service';
import {
  JOB_SCHEDULE_GENERATE,
  JOB_SCHEDULE_GENERATE_DEAD,
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
 *   - retryLimit: 1 → total 2 intentos. Después → dead-letter.
 *   - expireInSeconds: 180 → timeout duro 3 min por intento.
 *   - deadLetter: 'schedule.generate.dead' → al exhaustar retries,
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

    // Main queue — exclusive + retryLimit=1 + expire=3min + dead-letter.
    await boss.createQueue(JOB_SCHEDULE_GENERATE, {
      policy: 'exclusive',
      retryLimit: 1,
      expireInSeconds: 180,
      deadLetter: JOB_SCHEDULE_GENERATE_DEAD,
    });

    this.logger.log(
      `Queues ready: ${JOB_SCHEDULE_GENERATE} (exclusive, retry=1, expire=180s, dead→${JOB_SCHEDULE_GENERATE_DEAD})`,
    );
  }
}
