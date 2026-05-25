import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface LLMModelBudget {
  id: string;
  /** NULL = default global (aplicable a cualquier company). */
  companyId: string | null;
  model: string;
  monthlyBudgetTokens: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertBudgetInput {
  companyId: string | null;
  model: string;
  monthlyBudgetTokens: number;
  notes?: string | null;
}

/**
 * LLMModelBudgetService — CRUD del techo mensual de tokens por modelo.
 *
 * Resolución del budget efectivo (`getEffectiveBudget`):
 *   1. Override company-specific → si existe `(companyId, model)`, gana.
 *   2. Default global → fila con `company_id IS NULL`.
 *   3. Si no hay nada → `null` (el caller decide fallback: ej. 1M).
 */
@Injectable()
export class LLMModelBudgetService {
  private readonly logger = new Logger(LLMModelBudgetService.name);

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Lista los budgets visibles para `companyId`: globales (company_id NULL)
   * + overrides específicos. Útil para la UI de configuración del manager.
   */
  async listForCompany(companyId: string): Promise<LLMModelBudget[]> {
    const { data, error } = await this.supabase
      .from('llm_model_budgets')
      .select('*')
      .or(`company_id.is.null,company_id.eq.${companyId}`)
      .order('model');
    if (error) {
      this.logger.error(`listForCompany failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Devuelve el budget efectivo para `(companyId, model)`. Override
   * company > default global. `null` si no hay match.
   */
  async getEffectiveBudget(
    companyId: string,
    model: string,
  ): Promise<number | null> {
    const { data, error } = await this.supabase
      .from('llm_model_budgets')
      .select('monthly_budget_tokens, company_id')
      .or(`company_id.is.null,company_id.eq.${companyId}`)
      .eq('model', model);
    if (error) {
      this.logger.warn(`getEffectiveBudget failed: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) return null;
    // Preferir override company-specific.
    const override = data.find((r) => r.company_id === companyId);
    return (override ?? data[0]).monthly_budget_tokens as number;
  }

  /**
   * Upsert por `(companyId, model)`. Si `companyId` es null, escribe
   * el default global. Updated_at se refresca a now().
   */
  async upsert(input: UpsertBudgetInput): Promise<LLMModelBudget | null> {
    // Manual upsert: select por (companyId, model) → update o insert.
    // No usamos `.upsert()` directo de supabase porque el unique es
    // expression-based (COALESCE) y no matchea el conflict target.
    const existing = await this.findByCompanyModel(
      input.companyId,
      input.model,
    );
    if (existing) {
      const { data, error } = await this.supabase
        .from('llm_model_budgets')
        .update({
          monthly_budget_tokens: input.monthlyBudgetTokens,
          notes: input.notes ?? existing.notes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) {
        this.logger.error(`upsert update failed: ${error.message}`);
        return null;
      }
      return this.mapRow(data);
    }
    const { data, error } = await this.supabase
      .from('llm_model_budgets')
      .insert({
        company_id: input.companyId,
        model: input.model,
        monthly_budget_tokens: input.monthlyBudgetTokens,
        notes: input.notes ?? null,
      })
      .select('*')
      .single();
    if (error) {
      this.logger.error(`upsert insert failed: ${error.message}`);
      return null;
    }
    return this.mapRow(data);
  }

  async deleteById(id: string, companyId: string): Promise<boolean> {
    // Solo el dueño del row puede borrarlo. Defaults globales (company_id
    // NULL) no se pueden borrar via API tenant — solo via migration.
    const { error, count } = await this.supabase
      .from('llm_model_budgets')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) {
      this.logger.error(`deleteById failed: ${error.message}`);
      return false;
    }
    return (count ?? 0) > 0;
  }

  private async findByCompanyModel(
    companyId: string | null,
    model: string,
  ): Promise<LLMModelBudget | null> {
    let query = this.supabase
      .from('llm_model_budgets')
      .select('*')
      .eq('model', model);
    query =
      companyId === null
        ? query.is('company_id', null)
        : query.eq('company_id', companyId);
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    return this.mapRow(data);
  }

  private mapRow = (r: Record<string, unknown>): LLMModelBudget => ({
    id: r.id as string,
    companyId: (r.company_id as string | null) ?? null,
    model: r.model as string,
    monthlyBudgetTokens: r.monthly_budget_tokens as number,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });
}
