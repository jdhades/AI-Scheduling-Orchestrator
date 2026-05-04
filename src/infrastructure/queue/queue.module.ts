import { Global, Module } from '@nestjs/common';
import { PgBossService } from './pg-boss.service';
import { QueueBootstrapService } from './queue-bootstrap.service';
import { JobCancellationRegistry } from './job-cancellation.registry';

/**
 * QueueModule (Global)
 *
 * Lifecycle de pg-boss + bootstrap de queues. Global para que cualquier
 * provider/handler en otros módulos pueda inyectar `PgBossService` sin
 * importar este módulo explícitamente.
 *
 * Si `DATABASE_URL` no está seteada, pg-boss queda deshabilitado: la
 * app sigue funcionando con el path síncrono (Fase 0 lock activo).
 */
@Global()
@Module({
  providers: [PgBossService, QueueBootstrapService, JobCancellationRegistry],
  exports: [PgBossService, JobCancellationRegistry],
})
export class QueueModule {}
