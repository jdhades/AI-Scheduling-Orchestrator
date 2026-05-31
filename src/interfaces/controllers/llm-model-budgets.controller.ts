import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import {
  LLMModelBudgetService,
  type LLMModelBudget,
} from '../../domain/services/llm-model-budget.service';

class UpsertBudgetDto {
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
 * LLMModelBudgetsController
 *
 *   GET    /llm-model-budgets?companyId=...  → defaults globales + overrides
 *   PUT    /llm-model-budgets?companyId=...  → upsert override company-specific
 *   DELETE /llm-model-budgets/:id?companyId=... → quita el override (vuelve al global)
 */
@Controller('llm-model-budgets')
export class LLMModelBudgetsController {
  constructor(private readonly budgetService: LLMModelBudgetService) {}

  @Get()
  @Requires('settings:manage')
  async list(@CurrentCompany() companyId: string): Promise<LLMModelBudget[]> {
    return this.budgetService.listForCompany(companyId);
  }

  @Put()
  @Requires('settings:manage')
  async upsert(
    @CurrentCompany() companyId: string,
    @Body() dto: UpsertBudgetDto,
  ): Promise<LLMModelBudget> {
    const result = await this.budgetService.upsert({
      // Forzamos company-specific desde el HTTP — los defaults globales
      // se gestionan via migration, no via API expuesta a tenants.
      companyId,
      model: dto.model,
      monthlyBudgetTokens: dto.monthlyBudgetTokens,
      notes: dto.notes ?? null,
    });
    if (!result) {
      throw new NotFoundException('Failed to upsert budget');
    }
    return result;
  }

  @Delete(':id')
  @Requires('settings:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const ok = await this.budgetService.deleteById(id, companyId);
    if (!ok) {
      throw new NotFoundException(`Budget ${id} not found`);
    }
  }
}
