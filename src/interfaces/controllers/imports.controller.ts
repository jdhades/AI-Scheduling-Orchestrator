import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  IMPORT_STAGING_REPOSITORY,
  type IImportStagingRepository,
} from '../../domain/imports/import-staging.repository';
import { ImportStaging } from '../../domain/imports/import-staging.aggregate';
import type { ImportStagingStatus } from '../../domain/imports/import-payload.types';
import { ImportPayloadDto } from '../dtos/imports/import-payload.dto';
import { ConfirmImportDto } from '../dtos/imports/confirm-import.dto';
import { ImportValidatorService } from '../../application/imports/import-validator.service';
import {
  ImportPreviewBuilderService,
  type PreviewResult,
} from '../../application/imports/import-preview-builder.service';
import {
  ImportCommitterService,
  type CommitReport,
} from '../../application/imports/import-committer.service';

interface StagingResponse {
  id: string;
  source: string;
  status: ImportStagingStatus;
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
  summary: {
    locations: number;
    departments: number;
    roles: number;
    employees: number;
    shifts: number;
    availability: number;
    breaks: number;
    timeOff: number;
  };
}

/**
 * ImportsController — endpoints del sistema de importación multi-modal
 * (Fase 1, spine). Las 3 vías (upload libre, plantillas Excel, agente
 * externo) convergen acá vía POST /imports/staging — Fase 2+ agregan
 * los entrypoints específicos.
 */
@Controller('imports')
@Requires('imports:run')
export class ImportsController {
  private readonly logger = new Logger(ImportsController.name);

  constructor(
    @Inject(IMPORT_STAGING_REPOSITORY)
    private readonly repo: IImportStagingRepository,
    private readonly validator: ImportValidatorService,
    private readonly previewBuilder: ImportPreviewBuilderService,
    private readonly committer: ImportCommitterService,
  ) {}

  /**
   * POST /imports/staging — recibe payload canónico de cualquiera de
   * las 3 vías y lo stagea. Devuelve el id para que el frontend redirija
   * al preview.
   */
  @Post('staging')
  @HttpCode(HttpStatus.CREATED)
  async stage(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: ImportPayloadDto,
  ): Promise<StagingResponse> {
    const id = randomUUID();
    const staging = ImportStaging.create({
      id,
      companyId,
      createdBy: user?.employeeId ?? null,
      source: dto.source,
      payload: dto as unknown as Parameters<typeof ImportStaging.create>[0]['payload'],
    });
    await this.repo.save(staging);
    return this.toResponse(staging);
  }

  /**
   * GET /imports/staging/:id — metadata + summary del payload.
   */
  @Get('staging/:id')
  async get(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<StagingResponse> {
    const staging = await this.repo.findById(id, companyId);
    if (!staging) throw new NotFoundException('Import not found or expired');
    return this.toResponse(staging);
  }

  /**
   * GET /imports/staging/:id/preview — devuelve el plan completo
   * (will_create/update/skip por entidad + warnings + unresolved). Cachea
   * en `preview_cache` para no recalcular en cada visita.
   */
  @Get('staging/:id/preview')
  async preview(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<PreviewResult> {
    const staging = await this.repo.findById(id, companyId);
    if (!staging) throw new NotFoundException('Import not found or expired');
    if (staging.isExpired()) {
      throw new BadRequestException('Import expired — please re-upload');
    }
    if (staging.previewCache) {
      return staging.previewCache as PreviewResult;
    }
    const extraWarnings = this.validator.validate(staging.payload);
    const preview = await this.previewBuilder.build(
      staging.payload,
      companyId,
      extraWarnings,
    );
    await this.repo.save(staging.withPreviewCache(preview));
    return preview;
  }

  /**
   * POST /imports/staging/:id/confirm — commit al DB real. Devuelve el
   * report con qué se creó/actualizó/skipped/failed por entidad.
   */
  @Post('staging/:id/confirm')
  async confirm(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @Body() body: ConfirmImportDto,
  ): Promise<CommitReport> {
    const staging = await this.repo.findById(id, companyId);
    if (!staging) throw new NotFoundException('Import not found or expired');
    if (staging.status !== 'pending_review') {
      throw new BadRequestException(
        `Cannot confirm import in status "${staging.status}"`,
      );
    }
    // Asegurar que el preview esté cacheado — sino el plan default
    // (will_create vs will_update) no está calculado.
    let preview = staging.previewCache as PreviewResult | null;
    if (!preview) {
      const extraWarnings = this.validator.validate(staging.payload);
      preview = await this.previewBuilder.build(
        staging.payload,
        companyId,
        extraWarnings,
      );
    }
    const confirming = staging.markConfirming().withPreviewCache(preview);
    await this.repo.save(confirming);

    try {
      const report = await this.committer.commit({
        importId: id,
        companyId,
        payload: staging.payload,
        preview,
        decisions: body.decisions,
      });
      await this.repo.save(confirming.markCommitted(report));
      return report;
    } catch (err) {
      const errorReport = {
        error: (err as Error).message,
        at: new Date().toISOString(),
      };
      await this.repo.save(confirming.markFailed(errorReport));
      throw err;
    }
  }

  /**
   * DELETE /imports/staging/:id — descarta el staging. No borra el row
   * (lo deja como 'discarded' para auditoría) — el cleanup job lo borra
   * cuando expira.
   */
  @Delete('staging/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const staging = await this.repo.findById(id, companyId);
    if (!staging) throw new NotFoundException('Import not found or expired');
    await this.repo.save(staging.markDiscarded());
  }

  private toResponse(s: ImportStaging): StagingResponse {
    const d = s.payload.data;
    return {
      id: s.id,
      source: s.source,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      committedAt: s.committedAt?.toISOString() ?? null,
      summary: {
        locations: d.locations?.length ?? 0,
        departments: d.departments?.length ?? 0,
        roles: d.roles?.length ?? 0,
        employees: d.employees?.length ?? 0,
        shifts: d.shifts?.length ?? 0,
        availability: d.availability?.length ?? 0,
        breaks: d.breaks?.length ?? 0,
        timeOff: d.timeOff?.length ?? 0,
      },
    };
  }
}
