import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';

export class CreateLocationDto {
  @IsString()
  @IsNotEmpty()
  branchId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsNumber()
  @IsLatitude()
  geofenceLat!: number;

  @IsNumber()
  @IsLongitude()
  geofenceLng!: number;

  @IsInt()
  @Min(1)
  geofenceRadiusM!: number;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsLatitude()
  geofenceLat?: number;

  @IsOptional()
  @IsNumber()
  @IsLongitude()
  geofenceLng?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  geofenceRadiusM?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

interface LocationRow {
  id: string;
  branch_id: string;
  name: string;
  geofence_lat: number;
  geofence_lng: number;
  geofence_radius_m: number;
  is_active: boolean;
}

interface LocationDTO {
  id: string;
  branchId: string;
  name: string;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusM: number;
  isActive: boolean;
}

const COLS = 'id, branch_id, name, geofence_lat, geofence_lng, geofence_radius_m, is_active';

function toDTO(r: LocationRow): LocationDTO {
  return {
    id: r.id,
    branchId: r.branch_id,
    name: r.name,
    geofenceLat: r.geofence_lat,
    geofenceLng: r.geofence_lng,
    geofenceRadiusM: r.geofence_radius_m,
    isActive: r.is_active,
  };
}

/**
 * LocationsController — CRUD of physical sites under a branch.
 *
 * Gated by the tenant feature flag 'locations' (paid add-on). Every endpoint
 * returns 403 when the flag is off for the tenant. Tenant comes from the JWT.
 *   GET    /locations[?branchId=]  → active locations
 *   POST   /locations             → create (branches:write)
 *   PATCH  /locations/:id          → update (branches:write)
 *   DELETE /locations/:id          → soft delete (branches:write)
 */
@Controller('locations')
export class LocationsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly tenantFeatures: TenantFeatureService,
  ) {}

  private async ensureEnabled(companyId: string): Promise<void> {
    const on = await this.tenantFeatures.isEnabled(companyId, 'locations');
    if (!on) {
      throw new ForbiddenException('The "locations" feature is not enabled for this company');
    }
  }

  @Get()
  async list(
    @CurrentCompany() companyId: string,
    @Query('branchId') branchId?: string,
  ): Promise<LocationDTO[]> {
    await this.ensureEnabled(companyId);
    let q = this.supabase
      .from('locations')
      .select(COLS)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (branchId) q = q.eq('branch_id', branchId);
    const { data, error } = await q.returns<LocationRow[]>();
    if (error) throw new Error(error.message);
    return (data ?? []).map(toDTO);
  }

  @Post()
  @Requires('branches:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateLocationDto,
    @CurrentCompany() companyId: string,
  ): Promise<LocationDTO> {
    await this.ensureEnabled(companyId);
    const { data, error } = await this.supabase
      .from('locations')
      .insert({
        company_id: companyId,
        branch_id: dto.branchId,
        name: dto.name,
        geofence_lat: dto.geofenceLat,
        geofence_lng: dto.geofenceLng,
        geofence_radius_m: dto.geofenceRadiusM,
      })
      .select(COLS)
      .single<LocationRow>();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(`A location named "${dto.name}" already exists in this branch`);
      }
      if ((error as { code?: string }).code === '23503') {
        throw new BadRequestException(`Branch ${dto.branchId} does not exist in this company`);
      }
      throw new Error(error.message);
    }
    return toDTO(data);
  }

  @Patch(':id')
  @Requires('branches:write')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @CurrentCompany() companyId: string,
  ): Promise<LocationDTO> {
    await this.ensureEnabled(companyId);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.geofenceLat !== undefined) patch.geofence_lat = dto.geofenceLat;
    if (dto.geofenceLng !== undefined) patch.geofence_lng = dto.geofenceLng;
    if (dto.geofenceRadiusM !== undefined) patch.geofence_radius_m = dto.geofenceRadiusM;
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;

    const { data, error } = await this.supabase
      .from('locations')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select(COLS)
      .maybeSingle<LocationRow>();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(`A location with that name already exists in this branch`);
      }
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Location ${id} not found`);
    return toDTO(data);
  }

  @Delete(':id')
  @Requires('branches:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.ensureEnabled(companyId);
    // Soft delete: keep history (timeclock/schedule may reference it later).
    const { error } = await this.supabase
      .from('locations')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw new Error(error.message);
  }
}
