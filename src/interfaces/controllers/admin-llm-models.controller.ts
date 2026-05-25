import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

export interface AvailableLLMModelRow {
  id: string;
  provider: 'qwen' | 'gemini' | 'local';
  model: string;
  label: string | null;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

class CreateModelDto {
  @IsIn(['qwen', 'gemini', 'local'])
  provider!: 'qwen' | 'gemini' | 'local';

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

class UpdateModelDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * AdminLLMModelsController — whitelist de (provider, model) que el admin
 * usa para poblar el dropdown del LlmConfigDialog. UX-only — el backend
 * acepta cualquier string a nivel del PATCH llm-config.
 *
 *   GET    /admin/llm-models       → lista
 *   POST   /admin/llm-models       → crear
 *   PUT    /admin/llm-models/:id   → editar (label/notes/enabled)
 *   DELETE /admin/llm-models/:id   → borrar
 */
@Controller('admin/llm-models')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminLLMModelsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  async list(): Promise<AvailableLLMModelRow[]> {
    const { data, error } = await this.supabase
      .from('available_llm_models')
      .select('*')
      .order('provider')
      .order('model');
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map(this.toRow);
  }

  @Post()
  async create(@Body() dto: CreateModelDto): Promise<AvailableLLMModelRow> {
    const { data, error } = await this.supabase
      .from('available_llm_models')
      .insert({
        provider: dto.provider,
        model: dto.model,
        label: dto.label ?? null,
        notes: dto.notes ?? null,
        enabled: dto.enabled ?? true,
      })
      .select('*')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new BadRequestException(
          `Model ${dto.provider}/${dto.model} already exists`,
        );
      }
      throw new BadRequestException(error.message);
    }
    return this.toRow(data);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateModelDto,
  ): Promise<AvailableLLMModelRow> {
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.label !== undefined) update.label = dto.label || null;
    if (dto.notes !== undefined) update.notes = dto.notes || null;
    if (dto.enabled !== undefined) update.enabled = dto.enabled;

    const { data, error } = await this.supabase
      .from('available_llm_models')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Model not found');
    return this.toRow(data);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    const { error, count } = await this.supabase
      .from('available_llm_models')
      .delete({ count: 'exact' })
      .eq('id', id);
    if (error) throw new BadRequestException(error.message);
    if (!count || count === 0) {
      throw new NotFoundException('Model not found');
    }
  }

  private toRow = (r: Record<string, unknown>): AvailableLLMModelRow => ({
    id: r.id as string,
    provider: r.provider as AvailableLLMModelRow['provider'],
    model: r.model as string,
    label: (r.label as string | null) ?? null,
    enabled: r.enabled as boolean,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });
}
