import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import type {
  ImportPayload,
  ImportWarning,
  UnresolvedReference,
} from '../../domain/imports/import-payload.types';

/**
 * ImportPreviewBuilder — calcula el "plan" para cada entidad del payload:
 * crear nuevo, hacer match con una existente (update), o quedar como
 * unresolved.
 *
 * Fase 1 (spine):
 *   - Match real solo para Employees por email/phone (los más caros si
 *     se duplican).
 *   - Match real para Roles/Departments/Branches por name (case-insensitive).
 *   - Shifts: en Fase 1 siempre "will_create" — no hacemos match contra
 *     assignments existentes (lo agregamos en Fase 5 cuando importemos
 *     históricos).
 *   - Resto: "will_create".
 *
 * El committer respeta este plan salvo override del owner en
 * `ConfirmImportDto.decisions`.
 */

export type PreviewPlan = 'will_create' | 'will_update' | 'skip' | 'unresolved';

export interface PreviewRow {
  externalId: string;
  plan: PreviewPlan;
  matchedId?: string;
  matchedLabel?: string;
  confidence?: number;
  /**
   * Si la entidad está en el payload pero alguna validación cross-entity
   * la marcó (ej. email duplicado), severity ≥ 'error' significa que
   * por default se skip al confirmar (pero owner puede overridear).
   */
  blockedByError?: boolean;
}

export interface PreviewByEntity {
  locations: PreviewRow[];
  departments: PreviewRow[];
  roles: PreviewRow[];
  employees: PreviewRow[];
  shifts: PreviewRow[];
  availability: PreviewRow[];
  breaks: PreviewRow[];
  timeOff: PreviewRow[];
}

export interface PreviewResult {
  entities: PreviewByEntity;
  warnings: ImportWarning[];
  unresolvedReferences: UnresolvedReference[];
  summary: {
    willCreate: number;
    willUpdate: number;
    skip: number;
    unresolved: number;
  };
  /** Snapshot de confianza global del lote — usado por la UI para colorear. */
  globalConfidence: number | null;
  /** Threshold del tenant aplicado al colorear filas en la UI. */
  confidenceThreshold: number;
}

@Injectable()
export class ImportPreviewBuilderService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async build(
    payload: ImportPayload,
    companyId: string,
    extraWarnings: ImportWarning[],
  ): Promise<PreviewResult> {
    const errorsByExternalId = new Set<string>();
    for (const w of [...(payload.warnings ?? []), ...extraWarnings]) {
      if (w.severity === 'error' && w.entityRef) {
        errorsByExternalId.add(
          `${w.entityRef.entity}:${w.entityRef.externalId}`,
        );
      }
    }

    const threshold = await this.getConfidenceThreshold(companyId);

    const entities: PreviewByEntity = {
      locations: await this.buildSimple(
        payload.data.locations ?? [],
        'locations',
        errorsByExternalId,
        async (rows) => this.matchByName(rows, 'branches', companyId),
      ),
      departments: await this.buildSimple(
        payload.data.departments ?? [],
        'departments',
        errorsByExternalId,
        async (rows) => this.matchByName(rows, 'departments', companyId),
      ),
      roles: await this.buildSimple(
        payload.data.roles ?? [],
        'roles',
        errorsByExternalId,
        async (rows) => this.matchRolesByName(rows, companyId),
      ),
      employees: await this.buildEmployees(
        payload,
        companyId,
        errorsByExternalId,
      ),
      shifts: this.buildAllCreate(payload.data.shifts ?? [], errorsByExternalId),
      availability: this.buildAllCreate(
        payload.data.availability ?? [],
        errorsByExternalId,
      ),
      breaks: this.buildAllCreate(
        payload.data.breaks ?? [],
        errorsByExternalId,
      ),
      timeOff: this.buildAllCreate(
        payload.data.timeOff ?? [],
        errorsByExternalId,
      ),
    };

    const summary = this.computeSummary(entities);

    return {
      entities,
      warnings: [...(payload.warnings ?? []), ...extraWarnings],
      unresolvedReferences: payload.unresolvedReferences ?? [],
      summary,
      globalConfidence: payload.sourceMetadata.confidence ?? null,
      confidenceThreshold: threshold,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────

  private async getConfidenceThreshold(companyId: string): Promise<number> {
    const { data } = await this.supabase
      .from('companies')
      .select('imports_confidence_threshold')
      .eq('id', companyId)
      .maybeSingle();
    return (data?.imports_confidence_threshold as number | undefined) ?? 0.85;
  }

  private buildAllCreate(
    rows: Array<{ externalId: string; confidence?: number }>,
    errorIds: Set<string>,
  ): PreviewRow[] {
    return rows.map((r) => ({
      externalId: r.externalId,
      plan: 'will_create',
      confidence: r.confidence,
      blockedByError: errorIds.has(this.refKey('any', r.externalId)),
    }));
  }

  /** Build genérico con un matcher inyectado por entidad. */
  private async buildSimple(
    rows: Array<{ externalId: string; name?: string; confidence?: number }>,
    entityKey: string,
    errorIds: Set<string>,
    matcher: (
      rows: Array<{ externalId: string; name?: string }>,
    ) => Promise<Map<string, { id: string; label: string }>>,
  ): Promise<PreviewRow[]> {
    if (rows.length === 0) return [];
    const matches = await matcher(rows);
    return rows.map((r) => {
      const m = matches.get(r.externalId);
      const blocked = errorIds.has(`${entityKey}:${r.externalId}`);
      if (m) {
        return {
          externalId: r.externalId,
          plan: 'will_update',
          matchedId: m.id,
          matchedLabel: m.label,
          confidence: r.confidence,
          blockedByError: blocked,
        };
      }
      return {
        externalId: r.externalId,
        plan: 'will_create',
        confidence: r.confidence,
        blockedByError: blocked,
      };
    });
  }

  private async buildEmployees(
    payload: ImportPayload,
    companyId: string,
    errorIds: Set<string>,
  ): Promise<PreviewRow[]> {
    const rows = payload.data.employees ?? [];
    if (rows.length === 0) return [];

    const emails = rows.map((r) => r.email).filter(Boolean) as string[];
    const phones = rows.map((r) => r.phone).filter(Boolean) as string[];

    const byEmail = new Map<string, { id: string; label: string }>();
    const byPhone = new Map<string, { id: string; label: string }>();

    if (emails.length > 0) {
      const { data } = await this.supabase
        .from('employees')
        .select('id, name, email')
        .eq('company_id', companyId)
        .in('email', emails)
        .is('deleted_at', null);
      for (const r of (data ?? []) as Array<{
        id: string;
        name: string;
        email: string;
      }>) {
        byEmail.set(r.email.toLowerCase(), { id: r.id, label: r.name });
      }
    }
    if (phones.length > 0) {
      const { data } = await this.supabase
        .from('employees')
        .select('id, name, phone_number')
        .eq('company_id', companyId)
        .in('phone_number', phones)
        .is('deleted_at', null);
      for (const r of (data ?? []) as Array<{
        id: string;
        name: string;
        phone_number: string;
      }>) {
        byPhone.set(r.phone_number, { id: r.id, label: r.name });
      }
    }

    return rows.map((r) => {
      const blocked = errorIds.has(`employees:${r.externalId}`);
      const m =
        (r.email ? byEmail.get(r.email.toLowerCase()) : undefined) ??
        (r.phone ? byPhone.get(r.phone) : undefined);
      if (m) {
        return {
          externalId: r.externalId,
          plan: 'will_update',
          matchedId: m.id,
          matchedLabel: m.label,
          confidence: r.confidence,
          blockedByError: blocked,
        };
      }
      return {
        externalId: r.externalId,
        plan: 'will_create',
        confidence: r.confidence,
        blockedByError: blocked,
      };
    });
  }

  /** Match por nombre case-insensitive contra tabla. */
  private async matchByName(
    rows: Array<{ externalId: string; name?: string }>,
    table: 'branches' | 'departments' | 'company_skills',
    companyId: string,
    nameCol: string = 'name',
  ): Promise<Map<string, { id: string; label: string }>> {
    const names = rows.map((r) => r.name?.toLowerCase()).filter(Boolean) as string[];
    if (names.length === 0) return new Map();
    // Cast a unknown — Supabase no resuelve el column interpolated en
    // TS y tira ParserError; runtime sí funciona.
    const res = (await this.supabase
      .from(table)
      .select(`id, ${nameCol}`)
      .eq('company_id', companyId)
      .is('deleted_at', null)) as unknown as {
      data: Array<Record<string, string>> | null;
    };
    const byNameLower = new Map<string, { id: string; label: string }>();
    for (const r of res.data ?? []) {
      const n = r[nameCol];
      if (typeof n === 'string') {
        byNameLower.set(n.toLowerCase(), { id: r.id, label: n });
      }
    }
    const out = new Map<string, { id: string; label: string }>();
    for (const r of rows) {
      const m = r.name ? byNameLower.get(r.name.toLowerCase()) : undefined;
      if (m) out.set(r.externalId, m);
    }
    return out;
  }

  /**
   * Match roles: `company_skills` es un link (company_id, skill_id) — el
   * name vive en `skills`. JOIN explícito vía select embed para devolver
   * (id, skills.name) por cada link activo del tenant.
   */
  private async matchRolesByName(
    rows: Array<{ externalId: string; name?: string }>,
    companyId: string,
  ): Promise<Map<string, { id: string; label: string }>> {
    const names = rows
      .map((r) => r.name?.toLowerCase())
      .filter(Boolean) as string[];
    if (names.length === 0) return new Map();
    const { data } = (await this.supabase
      .from('company_skills')
      .select('id, skills(name)')
      .eq('company_id', companyId)
      .is('deleted_at', null)) as unknown as {
      data: Array<{ id: string; skills: { name: string } | null }> | null;
    };
    const byNameLower = new Map<string, { id: string; label: string }>();
    for (const r of data ?? []) {
      const n = r.skills?.name;
      if (typeof n === 'string') {
        byNameLower.set(n.toLowerCase(), { id: r.id, label: n });
      }
    }
    const out = new Map<string, { id: string; label: string }>();
    for (const r of rows) {
      const m = r.name ? byNameLower.get(r.name.toLowerCase()) : undefined;
      if (m) out.set(r.externalId, m);
    }
    return out;
  }

  private refKey(entity: string, externalId: string): string {
    return `${entity}:${externalId}`;
  }

  private computeSummary(entities: PreviewByEntity): PreviewResult['summary'] {
    let willCreate = 0;
    let willUpdate = 0;
    let skip = 0;
    let unresolved = 0;
    for (const list of Object.values(entities)) {
      for (const r of list) {
        if (r.plan === 'will_create') willCreate++;
        else if (r.plan === 'will_update') willUpdate++;
        else if (r.plan === 'skip') skip++;
        else unresolved++;
      }
    }
    return { willCreate, willUpdate, skip, unresolved };
  }
}
