import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AllowlistEntry {
  id: string;
  companyId: string;
  provider: string;
  model: string;
  createdAt: string;
}

/**
 * CompanyLlmAllowlistService — whitelist per-tenant de (provider, model).
 *
 * Semántica: sin filas para una company → cualquier modelo del catálogo
 * está permitido (compat con tenants legacy). Con filas → solo esos
 * (provider, model). El admin la administra desde el panel.
 *
 * El consumo en runtime lo hace `LlmResolverService._pickProvider` antes
 * de devolver el ILLMService — si el chequeo falla, lanza
 * `LlmProviderNotAllowedException`.
 */
@Injectable()
export class CompanyLlmAllowlistService {
  private readonly logger = new Logger(CompanyLlmAllowlistService.name);

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  async listForCompany(companyId: string): Promise<AllowlistEntry[]> {
    const { data, error } = await this.supabase
      .from('company_llm_allowlist')
      .select('*')
      .eq('company_id', companyId)
      .order('provider')
      .order('model');
    if (error) {
      this.logger.warn(`listForCompany failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Check de enforcement. Si la company NO tiene ninguna fila en
   * allowlist → todo permitido (true). Si tiene al menos una, solo los
   * (provider, model) explícitamente listados están permitidos.
   *
   * Fail-open: si la query rompe, retorna true para no bloquear flujos
   * críticos. El warning queda en logs y el admin monitor lo ve.
   */
  async isAllowed(
    companyId: string,
    provider: string,
    model: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('company_llm_allowlist')
      .select('provider, model')
      .eq('company_id', companyId);
    if (error) {
      this.logger.warn(
        `isAllowed query failed: ${error.message} — fail-open (return true)`,
      );
      return true;
    }
    const rows = data ?? [];
    if (rows.length === 0) return true; // sin restricciones
    return rows.some(
      (r) =>
        (r.provider as string) === provider && (r.model as string) === model,
    );
  }

  async add(
    companyId: string,
    provider: string,
    model: string,
  ): Promise<AllowlistEntry | null> {
    const { data, error } = await this.supabase
      .from('company_llm_allowlist')
      .insert({ company_id: companyId, provider, model })
      .select('*')
      .single();
    if (error) {
      this.logger.warn(`add failed: ${error.message}`);
      return null;
    }
    return this.mapRow(data);
  }

  async remove(companyId: string, entryId: string): Promise<boolean> {
    const { error, count } = await this.supabase
      .from('company_llm_allowlist')
      .delete({ count: 'exact' })
      .eq('id', entryId)
      .eq('company_id', companyId);
    if (error) return false;
    return (count ?? 0) > 0;
  }

  private mapRow = (r: Record<string, unknown>): AllowlistEntry => ({
    id: r.id as string,
    companyId: r.company_id as string,
    provider: r.provider as string,
    model: r.model as string,
    createdAt: r.created_at as string,
  });
}
