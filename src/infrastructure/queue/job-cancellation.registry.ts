import { Injectable, Logger } from '@nestjs/common';

/**
 * JobCancellationRegistry
 *
 * Mapa in-memory `jobId → AbortController` que permite cancelar
 * jobs `active` desde cualquier lugar del proceso. pg-boss v12 no
 * dispara `job.signal` cuando se llama `boss.cancel()` (solo cambia
 * el state en BD), entonces necesitamos nuestro propio canal.
 *
 * Limitación: single-instance only. Si en el futuro se separa el
 * worker del API en procesos distintos, hay que reemplazar esto por
 * Postgres LISTEN/NOTIFY o un canal de Redis pub/sub. Para nuestra
 * topología actual, in-memory es lo más simple y rápido.
 *
 * Lifecycle:
 *   - Worker llama `register(jobId)` al recibir el job, recibe
 *     un `AbortSignal` que pasa al pipeline (LLM proposer + handler).
 *   - Si el manager cancela vía POST /jobs/:id/cancel, el controller
 *     llama `abort(jobId)` después de `boss.cancel()`.
 *   - Worker llama `unregister(jobId)` en el finally para evitar leak
 *     de AbortControllers en jobs largos completados.
 */
@Injectable()
export class JobCancellationRegistry {
  private readonly logger = new Logger(JobCancellationRegistry.name);
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Registra un AbortController para `jobId` y devuelve el signal.
   * Si ya existía uno (no debería), lo aborta antes de reemplazarlo
   * para no dejar referencias colgadas.
   */
  register(jobId: string): AbortSignal {
    const existing = this.controllers.get(jobId);
    if (existing) {
      this.logger.warn(
        `Replacing existing controller for job=${jobId} — possible double register`,
      );
      existing.abort();
    }
    const ac = new AbortController();
    this.controllers.set(jobId, ac);
    return ac.signal;
  }

  /**
   * Aborta el AbortController asociado a `jobId`. Devuelve true si
   * había uno registrado, false si no (job ya terminó o no se
   * registró todavía).
   */
  abort(jobId: string, reason?: string): boolean {
    const ac = this.controllers.get(jobId);
    if (!ac) return false;
    if (ac.signal.aborted) return false;
    ac.abort(reason ?? 'Job cancelled by user');
    this.logger.log(`Aborted job=${jobId} (reason=${reason ?? 'user'})`);
    return true;
  }

  /**
   * Saca el AbortController del registry. Llamar en finally del
   * worker para liberar memoria y evitar leaks en runs largos.
   */
  unregister(jobId: string): void {
    this.controllers.delete(jobId);
  }
}
