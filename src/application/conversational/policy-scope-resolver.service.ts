import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  PolicyScope,
  PolicyScopeType,
} from '../../domain/aggregates/company-policy.aggregate';

export interface ResolvedScope {
  scope: PolicyScope;
  /** Nombre canónico del target tal como figura en BD (para feedback al manager). */
  targetName: string | null;
}

/**
 * PolicyScopeResolver — resuelve el `scopeName` extraído por el LLM al
 * `scope_id` real (UUID) del branch / department / employee dentro del
 * tenant. Si no encuentra match, devuelve scope=company como fallback —
 * el caller decide si avisar al manager o no.
 *
 * Phase 14.2 — usado por `MessageRouter` cuando llega un intent
 * `create_policy` con `scopeType` + `scopeName`. NO se invoca para
 * scope=company (no hay nada que resolver).
 *
 * Estrategia de matching:
 *   - exact-match case-insensitive en `name` de la tabla apropiada.
 *   - si no matchea, fallback a `ILIKE %name%` (substring) — capta
 *     errores tipográficos menores.
 *   - employees: además del `name`, prueba contra `phone_number` (manager
 *     puede mencionar el teléfono en vez del nombre).
 *   - si hay >1 match → ambigüedad: devuelve el primero pero loguea
 *     warning para que el manager confirme via UI.
 */
@Injectable()
export class PolicyScopeResolver {
  private readonly logger = new Logger(PolicyScopeResolver.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async resolve(input: {
    companyId: string;
    scopeType?: PolicyScopeType | null;
    scopeName?: string | null;
  }): Promise<ResolvedScope> {
    const type: PolicyScopeType = input.scopeType ?? 'company';
    if (type === 'company') {
      return { scope: { type: 'company', id: null }, targetName: null };
    }

    const name = input.scopeName?.trim();
    if (!name) {
      this.logger.warn(
        `PolicyScopeResolver: scopeType=${type} sin scopeName, falling back a company`,
      );
      return { scope: { type: 'company', id: null }, targetName: null };
    }

    const table =
      type === 'branch'
        ? 'branches'
        : type === 'department'
          ? 'departments'
          : 'employees';

    let id: string | null = null;
    let canonicalName: string | null = null;

    // 1. exact (ilike sin wildcards = case-insensitive)
    {
      const { data, error } = await this.supabase
        .from(table)
        .select('id, name')
        .eq('company_id', input.companyId)
        .ilike('name', name)
        .limit(2);
      if (error) {
        this.logger.warn(
          `PolicyScopeResolver exact lookup failed (${table}): ${error.message}`,
        );
      } else if (data && data.length > 0) {
        if (data.length > 1) {
          this.logger.warn(
            `PolicyScopeResolver: ${table} "${name}" tiene ${data.length} matches exactos — usando el primero (${data[0].id})`,
          );
        }
        id = (data[0] as { id: string }).id;
        canonicalName = (data[0] as { name: string }).name;
      }
    }

    // 2. substring (ilike %name%)
    if (!id) {
      const { data, error } = await this.supabase
        .from(table)
        .select('id, name')
        .eq('company_id', input.companyId)
        .ilike('name', `%${name}%`)
        .limit(2);
      if (error) {
        this.logger.warn(
          `PolicyScopeResolver substring lookup failed (${table}): ${error.message}`,
        );
      } else if (data && data.length > 0) {
        if (data.length > 1) {
          this.logger.warn(
            `PolicyScopeResolver: ${table} "${name}" tiene ${data.length} matches por substring — usando el primero (${data[0].id})`,
          );
        }
        id = (data[0] as { id: string }).id;
        canonicalName = (data[0] as { name: string }).name;
      }
    }

    // 3. employees: probar phone_number como último recurso
    if (!id && type === 'employee') {
      const { data, error } = await this.supabase
        .from('employees')
        .select('id, name')
        .eq('company_id', input.companyId)
        .eq('phone_number', name)
        .limit(1);
      if (error) {
        this.logger.warn(
          `PolicyScopeResolver employee phone lookup failed: ${error.message}`,
        );
      } else if (data && data.length > 0) {
        id = (data[0] as { id: string }).id;
        canonicalName = (data[0] as { name: string }).name;
      }
    }

    if (!id) {
      this.logger.warn(
        `PolicyScopeResolver: no se encontró ${type} "${name}" en companyId=${input.companyId}; fallback a company`,
      );
      return { scope: { type: 'company', id: null }, targetName: null };
    }

    return { scope: { type, id }, targetName: canonicalName };
  }
}
