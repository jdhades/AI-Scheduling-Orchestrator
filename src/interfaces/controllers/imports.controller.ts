import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
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
import {
  TemplateExcelBuilderService,
  type TemplateEntity,
} from '../../application/imports/template-excel-builder.service';
import {
  TemplateExcelParserService,
  ParseFatalError,
} from '../../application/imports/template-excel-parser.service';
import { ImportStorageService } from '../../infrastructure/services/import-storage.service';
import { LlmJobDispatcher } from '../../application/jobs/llm-job-dispatcher.service';

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
  /** Si status='failed', resumen del error para mostrar en la UI. */
  failureInfo: {
    phase: 'extract' | 'commit';
    message: string;
  } | null;
}

interface UploadExtractResponse {
  importId: string;
  jobId: string;
  status: ImportStagingStatus;
}

const UPLOAD_ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
] as const;

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

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
    private readonly templateBuilder: TemplateExcelBuilderService,
    private readonly templateParser: TemplateExcelParserService,
    private readonly storage: ImportStorageService,
    private readonly llmJobDispatcher: LlmJobDispatcher,
  ) {}

  // ─── Vía B (Excel) ─────────────────────────────────────────────────

  private static readonly TEMPLATE_ENTITIES: ReadonlySet<TemplateEntity> =
    new Set([
      'employees',
      'locations',
      'departments',
      'roles',
      'shifts',
      'availability',
      'breaks',
      'time_off',
    ]);

  /**
   * GET /imports/templates/:entity — descarga la plantilla xlsx para
   * una entidad. Server-side para que el formato se pueda iterar sin
   * redeploy. Cache-Control: short porque la plantilla puede cambiar.
   */
  @Get('templates/:entity')
  async downloadTemplate(
    @Param('entity') entityParam: string,
    @Res() res: Response,
  ): Promise<void> {
    if (
      !ImportsController.TEMPLATE_ENTITIES.has(entityParam as TemplateEntity)
    ) {
      throw new BadRequestException(
        `Unknown template entity "${entityParam}". Expected one of: ${[...ImportsController.TEMPLATE_ENTITIES].join(', ')}`,
      );
    }
    const buffer = this.templateBuilder.build(entityParam as TemplateEntity);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${entityParam}.xlsx"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buffer);
  }

  /**
   * POST /imports/templates/parse — multipart upload de N xlsx, parsea
   * a ImportPayload y crea staging directamente. Devuelve `{ importId }`
   * para que el frontend navegue al preview.
   *
   * Límite: 8 files × 10 MB cada uno. Validación strict — si cualquier
   * archivo tiene header missing o tipo inválido, ParseFatalError → 400
   * con el array de errores por archivo/celda.
   */
  @Post('templates/parse')
  @UseInterceptors(
    FilesInterceptor('files', 8, {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB por archivo
    }),
  )
  async parseTemplates(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<StagingResponse> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }

    let payload;
    try {
      payload = this.templateParser.parse(
        files.map((f) => ({
          originalName: f.originalname,
          buffer: f.buffer,
        })),
      );
    } catch (err) {
      if (err instanceof ParseFatalError) {
        // 400 con detalle por celda para que la UI muestre uno por uno.
        throw new BadRequestException({
          message: 'Excel parse failed',
          errorCode: 'IMPORT_EXCEL_PARSE_FAILED',
          errors: err.errors,
        });
      }
      throw err;
    }

    const id = randomUUID();
    const staging = ImportStaging.create({
      id,
      companyId,
      createdBy: user?.employeeId ?? null,
      source: 'template_excel',
      payload,
    });
    await this.repo.save(staging);
    return this.toResponse(staging);
  }

  // ─── Vía A (upload libre con vision LLM) ───────────────────────────

  /**
   * POST /imports/upload — multipart con 1 archivo (PDF/PNG/JPG/WEBP).
   * Sube al bucket privado, crea staging en status='extracting' y
   * encola el job de extracción. Devuelve `{ importId, jobId }` para
   * que el frontend escuche el WS y navegue a /imports/:id/preview
   * cuando termine.
   */
  @Post('upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_MAX_BYTES },
    }),
  )
  async upload(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<UploadExtractResponse> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (!UPLOAD_ALLOWED_MIME.includes(file.mimetype as never)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: ${UPLOAD_ALLOWED_MIME.join(', ')}.`,
      );
    }
    const importId = randomUUID();
    const storagePath = this.storage.buildPath(
      companyId,
      importId,
      file.mimetype,
    );
    const locale = this.resolveLocale(acceptLanguage);

    await this.storage.upload(storagePath, file.buffer, file.mimetype);

    const staging = ImportStaging.createForExtraction({
      id: importId,
      companyId,
      createdBy: user?.employeeId ?? null,
      storagePath,
      mimeType: file.mimetype,
    });
    await this.repo.save(staging);

    const jobId = await this.llmJobDispatcher.enqueue(
      'imports_extract',
      {
        companyId,
        actorEmployeeId: user?.employeeId ?? null,
        importId,
        storagePath,
        mimeType: file.mimetype,
        originalName: file.originalname,
        locale,
      },
      { label: file.originalname },
    );

    this.logger.log(
      `Upload received: importId=${importId} jobId=${jobId} mime=${file.mimetype} size=${file.size}`,
    );

    return {
      importId,
      jobId,
      status: staging.status,
    };
  }

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
      payload: dto as unknown as Parameters<
        typeof ImportStaging.create
      >[0]['payload'],
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
    if (staging.status === 'extracting') {
      // El worker todavía está corriendo vision sobre el upload. La UI
      // detecta el 425 y muestra un spinner — re-fetch al recibir el
      // WS LlmJobCompleted.
      throw new BadRequestException({
        message: 'Import is still being extracted by vision LLM',
        errorCode: 'IMPORT_STILL_EXTRACTING',
      });
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
      // El archivo original ya cumplió su propósito (payload commiteado).
      // Lo borramos para no pagar storage de algo que nadie va a abrir.
      if (staging.uploadStoragePath) {
        await this.storage.delete(staging.uploadStoragePath);
      }
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
   * cuando expira. Si tenía archivo en el bucket privado, se borra ya.
   */
  @Delete('staging/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const staging = await this.repo.findById(id, companyId);
    if (!staging) throw new NotFoundException('Import not found or expired');
    if (staging.uploadStoragePath) {
      await this.storage.delete(staging.uploadStoragePath);
    }
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
      failureInfo: this.extractFailureInfo(s),
    };
  }

  private extractFailureInfo(
    s: ImportStaging,
  ): StagingResponse['failureInfo'] {
    if (s.status !== 'failed') return null;
    const report = s.commitReport as
      | { phase?: 'extract' | 'commit'; error?: string }
      | null;
    return {
      phase: report?.phase ?? 'commit',
      message: report?.error ?? 'Unknown failure',
    };
  }

  /**
   * Mapea el header Accept-Language a uno de los 2 locales soportados
   * por el vision prompt. El frontend ya manda el lang seleccionado
   * por el user via axios; cualquier otro idioma cae a 'en'.
   */
  private resolveLocale(
    acceptLanguage: string | undefined,
  ): 'es' | 'en' {
    if (!acceptLanguage) return 'en';
    const primary = acceptLanguage.split(',')[0].trim().toLowerCase();
    if (primary.startsWith('es')) return 'es';
    return 'en';
  }
}
