import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import { ScopeService } from '../../infrastructure/auth/services/scope.service';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

/**
 * BranchesController — CRUD de sucursales (branches).
 *
 *   GET    /branches         → lista (filtra por scope para managers)
 *   POST   /branches         → crear (owner-only: 'branches:write')
 *   PATCH  /branches/:id     → editar nombre/timezone (owner-only)
 *   DELETE /branches/:id     → borrar (owner-only) — cascade a departments
 *
 * Owner full scope. Managers solo ven branches a las que están asignados
 * (direct via manager_scopes.scope_type='branch') o que contienen depts
 * que tienen asignados.
 */

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

interface BranchRow {
  id: string;
  name: string;
  timezone: string;
  createdAt: string;
  departmentCount: number;
}

@Controller('branches')
export class BranchesController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly scope: ScopeService,
  ) {}

  /**
   * GET /branches — lista filtrada por scope. Sin @Requires porque
   * cualquier auth user del tenant que pueda crear empleados o depts
   * necesita ver las branches existentes para asignarlos.
   */
  @Get()
  async list(@CurrentUser() user: AuthContext): Promise<BranchRow[]> {
    let query = this.supabase
      .from('branches')
      .select('id, name, timezone, created_at, departments(count)')
      .eq('company_id', user.companyId)
      .order('created_at', { ascending: true });

    // Manager con scope limitado: filtramos por las branches visibles
    if (user.role !== 'owner') {
      const visible = await this.scope.visibleBranchIds(user);
      if (visible !== null) {
        if (visible.length === 0) return [];
        query = query.in('id', visible);
      }
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((b) => ({
      id: b.id as string,
      name: b.name as string,
      timezone: b.timezone as string,
      createdAt: b.created_at as string,
      departmentCount:
        Array.isArray(b.departments) && b.departments[0]
          ? (b.departments[0].count ?? 0)
          : 0,
    }));
  }

  @Post()
  @Requires('branches:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateBranchDto,
  ): Promise<BranchRow> {
    const { data, error } = await this.supabase
      .from('branches')
      .insert({
        company_id: companyId,
        name: dto.name.trim(),
        timezone: dto.timezone?.trim() || 'UTC',
      })
      .select('id, name, timezone, created_at')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('Branch name already exists');
      }
      throw new BadRequestException(error.message);
    }
    return {
      id: data.id as string,
      name: data.name as string,
      timezone: data.timezone as string,
      createdAt: data.created_at as string,
      departmentCount: 0,
    };
  }

  @Patch(':id')
  @Requires('branches:write')
  async update(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateBranchDto,
  ): Promise<BranchRow> {
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.timezone !== undefined)
      patch.timezone = dto.timezone.trim() || 'UTC';
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    const { data, error } = await this.supabase
      .from('branches')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, name, timezone, created_at, departments(count)')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Branch not found');
    return {
      id: data.id as string,
      name: data.name as string,
      timezone: data.timezone as string,
      createdAt: data.created_at as string,
      departmentCount:
        Array.isArray(data.departments) && data.departments[0]
          ? (data.departments[0].count ?? 0)
          : 0,
    };
  }

  @Delete(':id')
  @Requires('branches:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    // Pre-check: si es la única branch, no permitimos delete (deja la
    // company sin estructura). El frontend muestra un mensaje claro.
    const { count } = await this.supabase
      .from('branches')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId);
    if ((count ?? 0) <= 1) {
      throw new BadRequestException(
        'Cannot delete the only branch — create another one first',
      );
    }
    const { error } = await this.supabase
      .from('branches')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw new BadRequestException(error.message);
  }
}
