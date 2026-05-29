import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { Job } from 'pg-boss';
import type { SupabaseClient } from '@supabase/supabase-js';
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
import type { ImportPayload } from '../../domain/imports/import-payload.types';

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
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
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
      // Snap to current week: el owner casi siempre sube un roster
      // "ejemplo" con fechas arbitrarias (mayo 2035 en plantilla típica).
      // Remapeamos las fechas para que la primera semana del payload
      // arranque en el lunes/domingo de la semana actual del tenant.
      // Multi-semana se preserva: w2 del archivo → semana siguiente, etc.
      const snappedPayload = await this.snapDatesToCurrentWeek(
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

  /**
   * Mapea las fechas del payload al "ahora" del tenant.
   *
   * Algoritmo:
   *   1. Mirar la fecha mínima entre shifts + timeOff.
   *   2. Calcular el weekStart de esa fecha según `companies.week_starts_on`.
   *   3. Computar offset = (weekStartActualTenant - weekStartDelPayload).
   *   4. Sumar ese offset (en días) a todas las fechas del payload
   *      (shifts.date, timeOff.startDate, timeOff.endDate).
   *
   * Multi-semana se preserva: si el payload tiene Lun W1 y Lun W2, el
   * shift result va a quedar en Lun semanaActual y Lun semanaActual+1.
   * No tocamos availability porque solo guarda dayOfWeek, no date.
   */
  private async snapDatesToCurrentWeek(
    payload: ImportPayload,
    companyId: string,
  ): Promise<ImportPayload> {
    const shifts = payload.data.shifts ?? [];
    const timeOff = payload.data.timeOff ?? [];
    if (shifts.length === 0 && timeOff.length === 0) {
      return payload;
    }

    const allDates: string[] = [
      ...shifts.map((s) => s.date),
      ...timeOff.map((t) => t.startDate),
    ].filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (allDates.length === 0) {
      return payload;
    }

    const minDate = allDates.sort()[0];
    const weekStartsOn = await this.getCompanyWeekStartsOn(companyId);

    const sourceWeekStart = this.weekStartOf(
      new Date(`${minDate}T00:00:00Z`),
      weekStartsOn,
    );
    const targetWeekStart = this.weekStartOf(new Date(), weekStartsOn);
    const offsetDays = Math.round(
      (targetWeekStart.getTime() - sourceWeekStart.getTime()) /
        (24 * 3600 * 1000),
    );

    if (offsetDays === 0) {
      // Ya está en la semana actual — nada que hacer.
      return payload;
    }

    this.logger.log(
      `Snap dates: ${minDate} (source week ${this.toIso(sourceWeekStart)}) → target week ${this.toIso(targetWeekStart)}, offset=${offsetDays}d`,
    );

    const shiftedShifts = shifts.map((s) => ({
      ...s,
      date: this.shiftIsoDate(s.date, offsetDays),
    }));
    const shiftedTimeOff = timeOff.map((t) => ({
      ...t,
      startDate: this.shiftIsoDate(t.startDate, offsetDays),
      endDate: this.shiftIsoDate(t.endDate, offsetDays),
    }));

    return {
      ...payload,
      data: {
        ...payload.data,
        shifts: shiftedShifts,
        timeOff: shiftedTimeOff,
      },
    };
  }

  private async getCompanyWeekStartsOn(
    companyId: string,
  ): Promise<'sunday' | 'monday'> {
    const { data } = await this.supabase
      .from('companies')
      .select('week_starts_on')
      .eq('id', companyId)
      .maybeSingle();
    const value = (data?.week_starts_on as string | undefined) ?? 'monday';
    return value === 'sunday' ? 'sunday' : 'monday';
  }

  private weekStartOf(d: Date, weekStartsOn: 'sunday' | 'monday'): Date {
    const day = d.getUTCDay(); // 0 = Sun, 1 = Mon
    const offset = weekStartsOn === 'sunday' ? day : (day + 6) % 7;
    const start = new Date(d);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - offset);
    return start;
  }

  private shiftIsoDate(iso: string, offsetDays: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return this.toIso(d);
  }

  private toIso(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
