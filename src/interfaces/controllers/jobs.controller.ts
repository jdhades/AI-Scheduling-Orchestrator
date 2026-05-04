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
import { JOB_SCHEDULE_GENERATE } from '../../infrastructure/queue/job-names';
import type { ScheduleGenerationJobPayload } from '../../infrastructure/queue/job-types';

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

  constructor(private readonly pgBoss: PgBossService) {}

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
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
    @Query('companyId') companyId: string,
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

    // Solo cancelar jobs que NO arrancaron (created/retry). Active +
    // completed + failed son no-op desde el panel; cancel mid-execution
    // se trabaja en Fase 3 con AbortController.
    if (job.state !== 'created' && job.state !== 'retry') {
      throw new ConflictException({
        error: 'job_not_cancellable',
        state: job.state,
        message:
          'Only pending jobs can be cancelled. Active jobs require advanced cancellation (Phase 3).',
      });
    }

    await boss.cancel(JobsController.QUEUE_NAME, id);
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
