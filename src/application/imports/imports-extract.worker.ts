import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { Job } from 'pg-boss';
import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import { JOB_IMPORTS_EXTRACT } from '../../infrastructure/queue/job-names';
import type { ImportsExtractJobPayload } from '../../infrastructure/queue/job-types';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { VisionResolverService } from './vision-resolver.service';
import { VisionExtractError } from './vision-extractor.interface';
import {
  IMPORT_STAGING_REPOSITORY,
  type IImportStagingRepository,
} from '../../domain/imports/import-staging.repository';
import { ImportStorageService } from '../../infrastructure/services/import-storage.service';
import { ImportDateSnapperService } from './import-date-snapper.service';

/**
 * ImportsExtractWorker
 *
 * Worker para el job `imports.extract` (Fase 3, upload libre). Flow:
 *  1. Lee el archivo del bucket privado `import-uploads`.
 *  2. Resuelve el extractor de visión configurado por el tenant.
 *  3. Llama `.extract()` y guarda el ImportPayload + raw output en el
 *     staging, transicionando status='extracting' → 'pending_review'.
 *  4. Emite WS LlmJobCompleted con `{ importId }` para que el frontend
 *     navegue a /imports/:id/preview.
 *
 * Errores no se reintentan (retryLimit=0 por convención del proyecto).
 * Los errores se persisten en el staging via markExtractFailed para
 * que la UI los muestre.
 */
@Injectable()
export class ImportsExtractWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImportsExtractWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly notifications: NotificationsGateway,
    private readonly visionResolver: VisionResolverService,
    private readonly storage: ImportStorageService,
    @Inject(IMPORT_STAGING_REPOSITORY)
    private readonly repo: IImportStagingRepository,
    private readonly snapper: ImportDateSnapperService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.ENABLE_WORKERS === 'false') {
      this.logger.log(
        'ENABLE_WORKERS=false — ImportsExtractWorker NOT registered',
      );
      return;
    }
    if (!this.pgBoss.isEnabled()) {
      this.logger.warn(
        'pg-boss disabled — ImportsExtractWorker NOT registered',
      );
      return;
    }
    const boss = this.pgBoss.getInstance();
    // Concurrencia 1: vision extractions son caras + serializadas por
    // tenant para no saturar el rate limit del provider.
    await boss.work<ImportsExtractJobPayload>(
      JOB_IMPORTS_EXTRACT,
      {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 2,
      },
      async (jobs) => {
        await Promise.allSettled(jobs.map((job) => this.handle(job)));
      },
    );
    this.logger.log(`ImportsExtractWorker ready: ${JOB_IMPORTS_EXTRACT}`);
  }

  private async handle(job: Job<ImportsExtractJobPayload>): Promise<void> {
    const { id: jobId, data: payload } = job;
    const { importId, companyId } = payload;

    const staging = await this.repo.findById(importId, companyId);
    if (!staging) {
      this.logger.warn(
        `Job ${jobId}: staging ${importId} not found (deleted?). Skipping.`,
      );
      // No emitimos WS — el originador ya no existe.
      return;
    }

    try {
      const buffer = await this.storage.download(payload.storagePath);
      const { extractor, model } =
        await this.visionResolver.forCompany(companyId);
      const result = await extractor.extract({
        buffer,
        mimeType: payload.mimeType,
        originalName: payload.originalName,
        modelOverride: model,
        companyId,
        locale: payload.locale,
      });
      // Snap to current week (con threshold) — extraído a un service
      // compartido para que stage/parseTemplates también lo usen.
      const snappedPayload = await this.snapper.snapIfNeeded(
        result.payload,
        companyId,
      );
      const updated = staging.withExtractedPayload(snappedPayload, result.raw);
      await this.repo.save(updated);

      this.notifications.notifyLlmJobCompleted(
        companyId,
        jobId,
        'imports_extract',
        {
          importId,
          status: 'pending_review',
          provider: result.raw.provider,
          model: result.raw.model,
        },
      );
      this.logger.log(
        `Job ${jobId} extract OK: importId=${importId} provider=${result.raw.provider} tokens=${result.raw.totalTokens ?? '?'}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof VisionExtractError ? err.cause : 'extractor_error';
      const rawText =
        err instanceof VisionExtractError ? err.rawText : undefined;
      try {
        await this.repo.save(
          staging.markExtractFailed({ message, cause }, rawText),
        );
      } catch (persistErr) {
        this.logger.error(
          `Failed to persist extract failure for ${importId}: ${(persistErr as Error).message}`,
        );
      }
      this.notifications.notifyLlmJobFailed(
        companyId,
        jobId,
        'imports_extract',
        message,
      );
      this.logger.error(
        `Job ${jobId} extract failed: importId=${importId} cause=${cause} msg=${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

}
