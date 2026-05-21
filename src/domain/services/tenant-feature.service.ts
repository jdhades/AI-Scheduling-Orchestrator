import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * TODO(hardcode): catálogo de feature keys hardcodeado — son toggles
 * internos del sistema (no datos de negocio). Sumar/quitar entries
 * a medida que aparezcan features experimentales/gated. Para sacarlo,
 * meter en una tabla `feature_definitions` cuando el catálogo crezca >20.
 */
export interface FeatureCatalogEntry {
  key: string;
  /** Nombre amigable para el admin. Texto literal, no i18n key. */
  label: string;
  description: string;
  /** Si el flag lleva payload JSON (ej. thresholds, listas). */
  hasPayload?: boolean;
}

export const FEATURE_CATALOG: ReadonlyArray<FeatureCatalogEntry> = [
  {
    key: 'whatsapp_inbound',
    label: 'WhatsApp inbound',
    description:
      'Habilita el endpoint de Twilio para procesar mensajes entrantes de empleados.',
  },
  {
    key: 'schedule_async',
    label: 'Schedule async generation',
    description:
      'Las generaciones de horario corren via pg-boss en background. Sin este flag, se mantiene el path síncrono.',
  },
  {
    key: 'policy_llm_runtime',
    label: 'Policy LLM runtime interpreter',
    description:
      'Permite que el LLM intervenga en runtime para interpretar policies que no matchean ningún interpreter estructurado.',
  },
  {
    key: 'fairness_postprocess',
    label: 'Fairness post-processing',
    description:
      'Aplica el segundo pase de fairness después de la generación inicial. Caro pero mejora equidad de carga.',
  },
  {
    key: 'shift_swaps_self_approve',
    label: 'Self-approve shift swaps',
    description:
      'Los empleados pueden auto-aprobar swaps entre pares sin pasar por el manager si los skills coinciden.',
    hasPayload: true,
  },
];

export interface TenantFeatureRow {
  id: string;
  companyId: string;
  featureKey: string;
  enabled: boolean;
  payload: unknown | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantFeatureView extends FeatureCatalogEntry {
  enabled: boolean;
  payload: unknown | null;
  notes: string | null;
  /** True si hay una fila en la tabla (override explícito). */
  hasOverride: boolean;
}

@Injectable()
export class TenantFeatureService {
  private readonly logger = new Logger(TenantFeatureService.name);

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Devuelve el catálogo entero + overrides aplicados para una company.
   * Features sin override aparecen con enabled=false (default).
   */
  async listForCompany(companyId: string): Promise<TenantFeatureView[]> {
    const { data, error } = await this.supabase
      .from('tenant_features')
      .select('*')
      .eq('company_id', companyId);
    if (error) {
      this.logger.warn(`listForCompany failed: ${error.message}`);
      return FEATURE_CATALOG.map((c) => this.merge(c, null));
    }
    const map = new Map<string, TenantFeatureRow>();
    for (const row of data ?? []) {
      map.set(row.feature_key as string, this.toRow(row));
    }
    return FEATURE_CATALOG.map((c) => this.merge(c, map.get(c.key) ?? null));
  }

  /**
   * Upsert override. Valida que la key exista en el catálogo — keys
   * inventadas no se aceptan.
   */
  async upsert(input: {
    companyId: string;
    featureKey: string;
    enabled: boolean;
    payload?: unknown;
    notes?: string | null;
  }): Promise<TenantFeatureView | null> {
    if (!FEATURE_CATALOG.find((c) => c.key === input.featureKey)) {
      this.logger.warn(`Unknown feature_key=${input.featureKey}`);
      return null;
    }
    const existing = await this.findOne(input.companyId, input.featureKey);
    if (existing) {
      const { data, error } = await this.supabase
        .from('tenant_features')
        .update({
          enabled: input.enabled,
          payload: input.payload ?? existing.payload,
          notes: input.notes ?? existing.notes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error || !data) return null;
      return this.merge(
        FEATURE_CATALOG.find((c) => c.key === input.featureKey)!,
        this.toRow(data),
      );
    }
    const { data, error } = await this.supabase
      .from('tenant_features')
      .insert({
        company_id: input.companyId,
        feature_key: input.featureKey,
        enabled: input.enabled,
        payload: input.payload ?? null,
        notes: input.notes ?? null,
      })
      .select('*')
      .single();
    if (error || !data) return null;
    return this.merge(
      FEATURE_CATALOG.find((c) => c.key === input.featureKey)!,
      this.toRow(data),
    );
  }

  /**
   * Borra el override — la feature vuelve al default (disabled).
   */
  async remove(companyId: string, featureKey: string): Promise<boolean> {
    const { error, count } = await this.supabase
      .from('tenant_features')
      .delete({ count: 'exact' })
      .eq('company_id', companyId)
      .eq('feature_key', featureKey);
    if (error) return false;
    return (count ?? 0) > 0;
  }

  /**
   * Atajo on-demand: ¿está habilitada esta feature para esta company?
   * Los consumidores (workers, controllers) llaman esto en runtime.
   */
  async isEnabled(companyId: string, featureKey: string): Promise<boolean> {
    const row = await this.findOne(companyId, featureKey);
    return row?.enabled ?? false;
  }

  private async findOne(
    companyId: string,
    featureKey: string,
  ): Promise<TenantFeatureRow | null> {
    const { data, error } = await this.supabase
      .from('tenant_features')
      .select('*')
      .eq('company_id', companyId)
      .eq('feature_key', featureKey)
      .maybeSingle();
    if (error || !data) return null;
    return this.toRow(data);
  }

  private toRow = (r: Record<string, unknown>): TenantFeatureRow => ({
    id: r.id as string,
    companyId: r.company_id as string,
    featureKey: r.feature_key as string,
    enabled: r.enabled as boolean,
    payload: r.payload ?? null,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });

  private merge(
    catalog: FeatureCatalogEntry,
    row: TenantFeatureRow | null,
  ): TenantFeatureView {
    return {
      ...catalog,
      enabled: row?.enabled ?? false,
      payload: row?.payload ?? null,
      notes: row?.notes ?? null,
      hasOverride: row !== null,
    };
  }
}
