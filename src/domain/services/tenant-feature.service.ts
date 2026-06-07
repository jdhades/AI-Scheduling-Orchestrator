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
  /**
   * Estado de la feature cuando no hay override explícito en
   * tenant_features. Sin esto, `isEnabled()` retornaría siempre false
   * y los flujos críticos (whatsapp, schedule_async, etc.) romperían
   * para todos los tenants nuevos.
   *
   * Convención: features estables que YA están en producción tienen
   * defaultEnabled=true (compat). Features experimentales o que
   * requieren infra adicional tienen defaultEnabled=false hasta que
   * soporte las prenda explícitamente por tenant.
   */
  defaultEnabled: boolean;
}

export const FEATURE_CATALOG: ReadonlyArray<FeatureCatalogEntry> = [
  {
    key: 'whatsapp_inbound',
    label: 'WhatsApp inbound',
    description:
      'Habilita el endpoint de Twilio para procesar mensajes entrantes de empleados.',
    defaultEnabled: true,
  },
  {
    key: 'fairness_postprocess',
    label: 'Fairness post-processing',
    description:
      'Reparte la carga entre empleados según su historia (ordena por score acumulado + bloquea turnos pesados a empleados saturados). Off por tenants chicos donde el balanceo genera más ruido que valor: el horario se construye en orden alfabético sin protección de score.',
    defaultEnabled: true,
  },
  {
    key: 'support_ticket_attachments',
    label: 'Support ticket attachments',
    description:
      'Permite que managers/owners adjunten imagen/video al reportar un error. Requiere que el bucket de Supabase Storage support-attachments esté configurado. Off por default — soporte la activa cuando confirma que el storage está listo.',
    defaultEnabled: false,
  },
  {
    key: 'help_ai_chat',
    label: 'Help — AI chat tab',
    description:
      'Habilita la pestaña de chat con IA dentro del panel de ayuda (HelpPanel). Off por default — el backend del chat todavía no está implementado, así que cuando se active hay que tener la knowledge base + el agente listos. Las pestañas Guías y Soporte funcionan sin este flag.',
    defaultEnabled: false,
  },
  {
    key: 'imports_allow_multiple',
    label: 'Imports — allow multiple committed imports',
    description:
      'Default OFF: el sistema rechaza un nuevo import si la company tiene un import committed que todavía no fue revertido y está dentro de la ventana de revert (7 días). El owner debe revertir el anterior o esperar a que expire. Encender este flag SOLO para tenants de testing — en producción genera empleados/turnos duplicados.',
    defaultEnabled: false,
  },
  {
    key: 'locations',
    label: 'Locations — multi-site under branches',
    description:
      'Add-on (default OFF): habilita locaciones físicas bajo una sucursal, cada una con su geofence (posición + radio) obligatorio. El marcaje valida contra la locación del turno, y el empleado puede quedar fijo o rotar entre locaciones (entra en scheduling + fairness). Tenants sin el flag usan la sucursal como único punto de marcaje (comportamiento por defecto).',
    defaultEnabled: false,
  },
];

// Removidos 2026-05-27 (con el user): flags sin caso de uso real,
// expuestos al admin solo generaban footguns (cualquiera podía
// apagarlos por error y romper un flow crítico).
//
//   - schedule_async       — el path sync legacy ya no se prueba desde
//                            el sprint async-policies; apagar el async
//                            deja el frontend esperando un WS que
//                            nunca llega. Path async = constante de
//                            arquitectura.
//   - policy_llm_runtime   — apagar significa que las policies hard
//                            que no matchean un interpreter quedan sin
//                            enforcement; compliance issue silencioso.
//                            El comportamiento correcto es always-on.
//
// Si en el futuro aparece un caso real para alguno, vuelve al catálogo
// con tests dedicados que cubran ambos paths ON/OFF.

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
   * Features sin override aparecen con enabled=defaultEnabled del catálogo
   * (no necesariamente false).
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
   *
   * Resolución:
   *   1. Si hay row en tenant_features → respeta `enabled` del override.
   *   2. Si NO hay row → cae al `defaultEnabled` del catálogo.
   *   3. Si la key no está en el catálogo → loguea warning y retorna false
   *      (defensive — keys inventadas no deberían pasar el upsert pero
   *      por si entran via SQL directo).
   */
  async isEnabled(companyId: string, featureKey: string): Promise<boolean> {
    const catalog = FEATURE_CATALOG.find((c) => c.key === featureKey);
    if (!catalog) {
      this.logger.warn(
        `isEnabled called with unknown feature_key=${featureKey} — returning false`,
      );
      return false;
    }
    const row = await this.findOne(companyId, featureKey);
    return row ? row.enabled : catalog.defaultEnabled;
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
      // Sin override, mostramos el default del catálogo. El admin UI
      // sigue distinguiendo override real vs default via `hasOverride`.
      enabled: row?.enabled ?? catalog.defaultEnabled,
      payload: row?.payload ?? null,
      notes: row?.notes ?? null,
      hasOverride: row !== null,
    };
  }
}
