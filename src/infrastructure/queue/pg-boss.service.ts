import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';

/**
 * PgBossService
 *
 * Wrapper del lifecycle de pg-boss. Arranca al boot de la app
 * (`OnModuleInit`) y para limpio en shutdown (`OnApplicationShutdown`).
 * pg-boss crea su propio schema `pgboss` en el primer arranque
 * (auto-migration interna); nada que hacer manualmente.
 *
 * Uso:
 *   - `getInstance()` devuelve el PgBoss listo para `send`/`work`.
 *   - Subscribers (workers) se registran desde otro lugar
 *     (ej. `OnModuleInit` de un módulo que dependa de éste).
 *
 * Coexistencia con el path síncrono: este servicio no hace nada hasta
 * que alguien envíe un job; no afecta la operación normal si el flag
 * `USE_ASYNC_SCHEDULE_GEN` está apagado.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PgBossService.name);
  private boss?: PgBoss;
  private startPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      this.logger.warn(
        'DATABASE_URL not set — pg-boss disabled. Set DATABASE_URL to enable async schedule generation.',
      );
      return;
    }

    this.boss = new PgBoss({
      connectionString,
      // Mantenemos el schema separado del resto del esquema de la app.
      schema: 'pgboss',
      // pg-boss internal pool. 5 es de sobra para single-instance; subible por
      // env (PGBOSS_POOL_MAX) al escalar workers/instancias.
      max: parseInt(process.env.PGBOSS_POOL_MAX ?? '5', 10) || 5,
      // v12 requiere flag explícito: crear el schema y correr migraciones
      // si la versión del schema en BD es vieja. Idempotentes.
      createSchema: true,
      migrate: true,
    });

    this.boss.on('error', (err: Error) => {
      this.logger.error(`pg-boss error: ${err.message}`, err.stack);
    });

    this.startPromise = this.boss.start().then(() => {
      this.logger.log('pg-boss started — schema=pgboss');
    });
    await this.startPromise;
  }

  /**
   * Promesa que resuelve cuando pg-boss terminó su `start()` (incluido
   * createSchema + migrate). Para que el bootstrap de queues / workers
   * puedan esperar regardless of init order.
   */
  ready(): Promise<void> {
    return this.startPromise;
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.stop({ graceful: true, timeout: 30_000 });
      this.logger.log('pg-boss stopped gracefully');
    } catch (err) {
      this.logger.warn(`pg-boss stop error: ${(err as Error).message}`);
    }
  }

  /**
   * Devuelve la instancia ya iniciada. Lanza si el módulo no terminó
   * `onModuleInit` (no debería pasar en uso normal — Nest espera a
   * que `onModuleInit` resuelva antes de marcar el app como ready).
   */
  getInstance(): PgBoss {
    if (!this.boss) {
      throw new Error(
        'pg-boss not initialized. Set DATABASE_URL or check startup logs.',
      );
    }
    return this.boss;
  }

  /** True si pg-boss está disponible (DATABASE_URL set + start ok). */
  isEnabled(): boolean {
    return this.boss !== undefined;
  }
}
