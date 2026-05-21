import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { JobWithMetadata } from 'pg-boss';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import { JobCancellationRegistry } from '../../infrastructure/queue/job-cancellation.registry';
import { JOB_SCHEDULE_GENERATE } from '../../infrastructure/queue/job-names';
import type { ScheduleGenerationJobPayload } from '../../infrastructure/queue/job-types';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { ScheduleGenerationLockService } from '../../domain/services/schedule-generation-lock.service';
import { ScheduleGenerationRunsService } from '../../domain/services/schedule-generation-runs.service';

interface JobStateDTO {
  id: string;
  name: string;
  state: JobWithMetadata['state'];
  retryCount: number;
  retryLimit: number;
  createdOn: string;
  startedOn: string | null;
  completedOn: string | null;
  payload: {
    companyId: string;
    weekStart: string;
    source: ScheduleGenerationJobPayload['source']['type'];
  };
}

/**
 * JobsController
 *
 * Endpoints para consultar y cancelar jobs de pg-boss desde el frontend
 * y/o el flow de WhatsApp (Fase 1 — async migration).
 *
 *   GET  /jobs/:id?companyId=...   → estado actual del job (polling)
 *   POST /jobs/:id/cancel?companyId=...  → cancela si está pending
 *
 * Auth multi-tenant: validamos que el job pertenezca a la company del
 * caller. Cualquier mismatch → 404 (no leakeamos existencia entre
 * tenants).
 *
 * Por ahora `name` (queue) es siempre `schedule.generate`. Si se suman
 * otros queues, exponer un query `?queue=...`.
 */
@Controller('jobs')
export class JobsController {
  private static readonly QUEUE_NAME = JOB_SCHEDULE_GENERATE;
  private static readonly IN_FLIGHT_STATES: ReadonlyArray<JobWithMetadata['state']> = [
    'created',
    'retry',
    'active',
  ];

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly cancellationRegistry: JobCancellationRegistry,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly lockService: ScheduleGenerationLockService,
    private readonly runsService: ScheduleGenerationRunsService,
  ) {}

  /**
   * GET /jobs/active?companyId=...
   *
   * Devuelve los jobs `schedule.generate` en estados no-terminales
   * (created/retry/active) para la company del caller. El frontend lo
   * polea para detectar cuando vuelve a una página y hay un job en
   * curso (sin perder estado al navegar).
   *
   * Importante: declarar ANTES de `@Get(':id')` para que el path
   * 'active' no matchee `:id`.
   */
  @Get('active')
  async getActive(
    @CurrentCompany() companyId: string,
  ): Promise<JobStateDTO[]> {
    if (!this.pgBoss.isEnabled()) return [];
    const boss = this.pgBoss.getInstance();
    // findJobs con `data: { companyId }` filtra via `data @> $1` (jsonb
    // containment, indexable). El filtro de estado va en JS porque
    // findJobs no expone `state` filter; el set típico de jobs no-
    // terminales por company es chico (1-2), así que es barato.
    const jobs = await boss.findJobs<ScheduleGenerationJobPayload>(
      JobsController.QUEUE_NAME,
      { data: { companyId } },
    );
    return jobs
      .filter((j) =>
        JobsController.IN_FLIGHT_STATES.includes(j.state),
      )
      .sort(
        (a, b) =>
          new Date(b.createdOn).getTime() -
          new Date(a.createdOn).getTime(),
      )
      .map((j) => this._toDto(j));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<JobStateDTO> {
    if (!this.pgBoss.isEnabled()) {
      throw new NotFoundException('Queue not enabled');
    }
    const boss = this.pgBoss.getInstance();
    const job = await boss.getJobById<ScheduleGenerationJobPayload>(
      JobsController.QUEUE_NAME,
      id,
    );
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    // Multi-tenant gate — 404 si no es tuyo, NO 403 (no revelar existencia).
    if (job.data.companyId !== companyId) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    return this._toDto(job);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!this.pgBoss.isEnabled()) {
      throw new NotFoundException('Queue not enabled');
    }
    const boss = this.pgBoss.getInstance();
    const job = await boss.getJobById<ScheduleGenerationJobPayload>(
      JobsController.QUEUE_NAME,
      id,
    );
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.data.companyId !== companyId) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    // Cancel disponible en created/retry/active (Fase 3). En active,
    // pg-boss aborta job.signal y el worker propaga al fetch del LLM —
    // si Qwen no responde de inmediato a la abort, el handler igual
    // chequea signal.aborted en checkpoints (entre intentos del verify-
    // loop, antes de persist) y bail-outs. Estados terminales (completed
    // /failed/cancelled) son no-op.
    if (
      job.state !== 'created' &&
      job.state !== 'retry' &&
      job.state !== 'active'
    ) {
      throw new ConflictException({
        error: 'job_not_cancellable',
        state: job.state,
        message:
          'Job is in a terminal state (completed/failed/cancelled). Cannot cancel.',
      });
    }

    await boss.cancel(JobsController.QUEUE_NAME, id);
    // Si el job estaba `active`, además de marcar state='cancelled' en
    // BD, abortamos el AbortController in-memory para que el worker
    // propague el cancel al fetch del LLM y los checkpoints internos.
    if (job.state === 'active') {
      const aborted = this.cancellationRegistry.abort(id, 'user-cancel');
      if (!aborted) {
        // El worker pudo haber terminado entre nuestro getJobById y la
        // llamada al registry — no es un error, el state ya está
        // 'cancelled' en BD y la BD es la fuente de verdad.
      }
      // Phase 4 — pre-release de la lock para que el manager pueda
      // re-disparar inmediato sin esperar a que el handler termine
      // de propagar el abort (puede tardar minutos si el LLM no
      // responde al signal). El handler usa lockToken=jobId, así su
      // finally NO pisa un lock futuro tomado por otro job.
      await this.lockService.release(
        job.data.companyId,
        job.data.weekStart,
        job.data.weekStartsOn,
        id,
      );
    }
    // Phase 4 — broadcast del cancel para que el banner se cierre
    // inmediato en todos los browsers conectados, sin esperar el
    // polling. Idempotente con el state='cancelled' en BD.
    this.notificationsGateway.notifyScheduleGenerationCancelled(
      job.data.companyId,
      job.data.weekStart,
      id,
    );

    // F.6 — pre-pickup cancel: el worker NUNCA va a procesar este
    // job, por lo tanto el handler tampoco va a registrar el run.
    // Acá lo escribimos para que aparezca en el histórico. Si el
    // worker ya estaba activo, su catch path va a recordear de nuevo
    // — el delete-by-jobId no aplica acá porque jobId es PK del run,
    // pero un duplicate insert por race es muy improbable (state
    // active+cancel ya está en el path del worker).
    if (job.state === 'created' || job.state === 'retry') {
      await this.runsService.record({
        companyId: job.data.companyId,
        weekStart: job.data.weekStart,
        jobId: id,
        status: 'cancelled',
        source: job.data.source.type,
        durationMs: 0,
      });
    }
  }

  private _toDto(job: JobWithMetadata<ScheduleGenerationJobPayload>): JobStateDTO {
    return {
      id: job.id,
      name: job.name,
      state: job.state,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
      createdOn: job.createdOn.toISOString(),
      startedOn: job.startedOn ? job.startedOn.toISOString() : null,
      completedOn: job.completedOn ? job.completedOn.toISOString() : null,
      payload: {
        companyId: job.data.companyId,
        weekStart: job.data.weekStart,
        source: job.data.source.type,
      },
    };
  }
}
