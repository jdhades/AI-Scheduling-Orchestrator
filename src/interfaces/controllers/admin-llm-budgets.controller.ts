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
  Put,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import {
  LLMModelBudgetService,
  type LLMModelBudget,
} from '../../domain/services/llm-model-budget.service';

export interface AdminBudgetRow extends LLMModelBudget {
  companyName: string | null;
}

class AdminUpsertBudgetDto {
  /** null = default global. UUID = override company-specific. */
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('all')
  companyId!: string | null;

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsInt()
  @IsPositive()
  monthlyBudgetTokens!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * AdminLLMBudgetsController — cross-tenant CRUD del techo de tokens
 * mensual por modelo. A diferencia del LLMModelBudgetsController normal
 * (que solo edita el override del propio tenant), este controller
 * puede:
 *   - Crear/editar defaults globales (companyId=null)
 *   - Crear overrides para cualquier tenant
 *   - Borrar cualquier fila (incluyendo globales)
 *
 * El tenant sigue gestionando su propio override via LLMModelBudgets;
 * este endpoint es para que el soporte configure los defaults o
 * intervenga si un tenant abusa.
 */
@Controller('admin/llm-budgets')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminLLMBudgetsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly budgetService: LLMModelBudgetService,
  ) {}

  @Get()
  async list(): Promise<AdminBudgetRow[]> {
    const { data, error } = await this.supabase
      .from('llm_model_budgets')
      .select('*')
      .order('company_id', { ascending: true, nullsFirst: true })
      .order('model');
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      company_id: string | null;
      model: string;
      monthly_budget_tokens: number;
      notes: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const companyNames = await this._fetchCompanyNames(
      rows.map((r) => r.company_id).filter((id): id is string => !!id),
    );
    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_id ? (companyNames.get(r.company_id) ?? null) : null,
      model: r.model,
      monthlyBudgetTokens: r.monthly_budget_tokens,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  @Put()
  async upsert(@Body() dto: AdminUpsertBudgetDto): Promise<LLMModelBudget> {
    const result = await this.budgetService.upsert({
      companyId: dto.companyId,
      model: dto.model,
      monthlyBudgetTokens: dto.monthlyBudgetTokens,
      notes: dto.notes ?? null,
    });
    if (!result) {
      throw new BadRequestException('Failed to upsert budget');
    }
    return result;
  }

  /**
   * Borrado directo por id, ignorando el scoping de company del
   * service tenant-facing (que requiere `eq('company_id', ...)`).
   * Soporte puede borrar globals si hace falta retirar un modelo.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    const { error, count } = await this.supabase
      .from('llm_model_budgets')
      .delete({ count: 'exact' })
      .eq('id', id);
    if (error) throw new BadRequestException(error.message);
    if (!count || count === 0) {
      throw new NotFoundException(`Budget ${id} not found`);
    }
  }

  private async _fetchCompanyNames(
    ids: string[],
  ): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return new Map();
    const { data, error } = await this.supabase
      .from('companies')
      .select('id, name')
      .in('id', unique);
    if (error) return new Map();
    return new Map(
      (data ?? []).map((c) => [c.id as string, (c.name as string) ?? '—']),
    );
  }
}
