import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import {
  TenantFeatureService,
  type TenantFeatureView,
  FEATURE_CATALOG,
  type FeatureCatalogEntry,
} from '../../domain/services/tenant-feature.service';

class UpsertFeatureDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  payload?: unknown;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * AdminTenantFeaturesController — habilita/deshabilita feature flags
 * por tenant. El catálogo se mantiene en código (FEATURE_CATALOG); este
 * endpoint solo gestiona los overrides.
 *
 *   GET    /admin/companies/:id/features          → catálogo + estado
 *   PUT    /admin/companies/:id/features/:key     → upsert override
 *   DELETE /admin/companies/:id/features/:key     → quita override
 *   GET    /admin/features/catalog                → solo catálogo (sin tenant)
 */
@Controller('admin')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminTenantFeaturesController {
  constructor(private readonly features: TenantFeatureService) {}

  @Get('features/catalog')
  catalog(): ReadonlyArray<FeatureCatalogEntry> {
    return FEATURE_CATALOG;
  }

  @Get('companies/:id/features')
  async list(@Param('id') id: string): Promise<TenantFeatureView[]> {
    return this.features.listForCompany(id);
  }

  @Put('companies/:id/features/:key')
  async upsert(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() body: UpsertFeatureDto,
  ): Promise<TenantFeatureView> {
    const result = await this.features.upsert({
      companyId: id,
      featureKey: key,
      enabled: body.enabled,
      payload: body.payload,
      notes: body.notes ?? null,
    });
    if (!result) {
      throw new BadRequestException('Unknown feature_key or update failed');
    }
    return result;
  }

  @Delete('companies/:id/features/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Param('key') key: string,
  ): Promise<void> {
    const ok = await this.features.remove(id, key);
    if (!ok) {
      throw new NotFoundException(
        `No override for feature_key=${key} on company=${id}`,
      );
    }
  }
}
