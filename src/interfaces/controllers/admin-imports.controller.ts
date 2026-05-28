import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import {
  IMPORT_STAGING_REPOSITORY,
  type IImportStagingRepository,
} from '../../domain/imports/import-staging.repository';

interface ImportRawDebugResponse {
  id: string;
  companyId: string;
  source: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  uploadStoragePath: string | null;
  uploadMimeType: string | null;
  payload: unknown;
  extractRawOutput: unknown;
  commitReport: unknown;
}

/**
 * AdminImportsController — endpoints cross-tenant para soporte/debug.
 *
 * GET /admin/imports/:id/raw devuelve el output crudo del vision LLM
 * (texto del modelo + usage tokens) + el payload extraído + el commit
 * report. Útil para iterar el prompt cuando un upload se ve raro o falla,
 * sin tener que loggear a la company del cliente.
 *
 * Restringido a platform_admin via @PlatformAdmin().
 */
@Controller('admin/imports')
@PlatformAdmin()
export class AdminImportsController {
  constructor(
    @Inject(IMPORT_STAGING_REPOSITORY)
    private readonly repo: IImportStagingRepository,
  ) {}

  @Get(':id/raw')
  async raw(@Param('id') id: string): Promise<ImportRawDebugResponse> {
    const staging = await this.repo.findByIdCrossTenant(id);
    if (!staging) {
      throw new NotFoundException(`Import ${id} not found`);
    }
    return {
      id: staging.id,
      companyId: staging.companyId,
      source: staging.source,
      status: staging.status,
      createdAt: staging.createdAt.toISOString(),
      expiresAt: staging.expiresAt.toISOString(),
      uploadStoragePath: staging.uploadStoragePath,
      uploadMimeType: staging.uploadMimeType,
      payload: staging.payload,
      extractRawOutput: staging.extractRawOutput,
      commitReport: staging.commitReport,
    };
  }
}
