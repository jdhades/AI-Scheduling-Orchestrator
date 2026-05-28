import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import type {
  ImportPayload,
  ImportRole,
  ImportLocation,
  ImportDepartment,
  ImportEmployee,
} from '../../domain/imports/import-payload.types';
import type {
  PreviewResult,
  PreviewRow,
} from './import-preview-builder.service';

/**
 * ImportCommitter — ejecuta el commit del payload aprobado al DB real.
 *
 * Política de transaccionalidad: **commit parcial con savepoints por
 * tipo de entidad**. Si dentro del grupo "employees" 3 ok + 1 falla,
 * se rollbackea solo ese employee. El `CommitReport` lista qué pasó
 * con cada fila.
 *
 * Orden de commit (FK dependencies):
 *   1. Locations (branches)
 *   2. Departments
 *   3. Roles (company_skills)
 *   4. Employees
 *   5. Availability / Breaks / Shifts / TimeOff — Fase 2+ (placeholders).
 *
 * Fase 1: las entidades 5+ se marcan como `skipped_phase` y NO se persisten.
 * Esto da vuelta el ciclo completo del spine (POST payload → preview →
 * confirm → commit en DB) sin tener que enchufar todos los handlers de
 * cada entidad de scheduling.
 */

export interface CommitRowOutcome {
  externalId: string;
  outcome: 'created' | 'updated' | 'skipped' | 'failed';
  id?: string;
  error?: string;
  reason?: string;
}

export interface CommitReport {
  /** ID del staging que se commiteó. */
  importId: string;
  startedAt: string;
  finishedAt: string;
  entities: {
    locations: CommitRowOutcome[];
    departments: CommitRowOutcome[];
    roles: CommitRowOutcome[];
    employees: CommitRowOutcome[];
    shifts: CommitRowOutcome[];
    availability: CommitRowOutcome[];
    breaks: CommitRowOutcome[];
    timeOff: CommitRowOutcome[];
  };
  totals: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
}

@Injectable()
export class ImportCommitterService {
  private readonly logger = new Logger(ImportCommitterService.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async commit(input: {
    importId: string;
    companyId: string;
    payload: ImportPayload;
    preview: PreviewResult;
    decisions?: Record<string, 'create' | 'update' | 'skip'>;
  }): Promise<CommitReport> {
    const startedAt = new Date().toISOString();
    const report: CommitReport = {
      importId: input.importId,
      startedAt,
      finishedAt: '',
      entities: {
        locations: [],
        departments: [],
        roles: [],
        employees: [],
        shifts: [],
        availability: [],
        breaks: [],
        timeOff: [],
      },
      totals: { created: 0, updated: 0, skipped: 0, failed: 0 },
    };

    // Maps externalId → realId (poblados a medida que vamos commiteando).
    // Permite resolver FKs intra-payload al persistir.
    const idMaps = {
      locations: new Map<string, string>(),
      departments: new Map<string, string>(),
      roles: new Map<string, string>(),
      employees: new Map<string, string>(),
    };

    await this.commitLocations(
      input,
      report.entities.locations,
      idMaps.locations,
    );
    await this.commitDepartments(
      input,
      report.entities.departments,
      idMaps.departments,
      idMaps.locations,
    );
    await this.commitRoles(input, report.entities.roles, idMaps.roles);
    await this.commitEmployees(
      input,
      report.entities.employees,
      idMaps.employees,
      idMaps.departments,
      idMaps.roles,
    );

    // Fase 2+ — placeholders. Marcamos todas las filas como skipped
    // con reason 'phase_pending' para que el owner sepa que pidió
    // datos que aún no se persisten desde import.
    this.skipAll(
      input.payload.data.shifts ?? [],
      report.entities.shifts,
      'phase_pending',
    );
    this.skipAll(
      input.payload.data.availability ?? [],
      report.entities.availability,
      'phase_pending',
    );
    this.skipAll(
      input.payload.data.breaks ?? [],
      report.entities.breaks,
      'phase_pending',
    );
    this.skipAll(
      input.payload.data.timeOff ?? [],
      report.entities.timeOff,
      'phase_pending',
    );

    report.finishedAt = new Date().toISOString();
    report.totals = this.computeTotals(report.entities);
    return report;
  }

  // ── Entidades implementadas en Fase 1 ─────────────────────────────

  private async commitLocations(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    idMap: Map<string, string>,
  ): Promise<void> {
    const rows = input.payload.data.locations ?? [];
    const planByExtId = this.planMap(input.preview.entities.locations);

    for (const r of rows) {
      const plan = this.resolvePlan(r.externalId, planByExtId, input.decisions);
      if (plan === 'skip') {
        out.push({
          externalId: r.externalId,
          outcome: 'skipped',
          reason: 'user_choice',
        });
        continue;
      }
      try {
        if (plan === 'will_update') {
          const matchedId = planByExtId.get(r.externalId)?.matchedId;
          if (!matchedId) throw new Error('update plan without matchedId');
          idMap.set(r.externalId, matchedId);
          // Update branch (timezone is the only optional field we touch)
          const { error } = await this.supabase
            .from('branches')
            .update({ name: r.name, timezone: r.timezone ?? null })
            .eq('id', matchedId)
            .eq('company_id', input.companyId);
          if (error) throw new Error(error.message);
          out.push({
            externalId: r.externalId,
            outcome: 'updated',
            id: matchedId,
          });
        } else {
          const id = randomUUID();
          const { error } = await this.supabase.from('branches').insert({
            id,
            company_id: input.companyId,
            name: r.name,
            timezone: r.timezone ?? null,
          });
          if (error) throw new Error(error.message);
          idMap.set(r.externalId, id);
          out.push({ externalId: r.externalId, outcome: 'created', id });
        }
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
        this.logger.warn(
          `Location ${r.externalId} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async commitDepartments(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    idMap: Map<string, string>,
    locMap: Map<string, string>,
  ): Promise<void> {
    const rows = input.payload.data.departments ?? [];
    const planByExtId = this.planMap(input.preview.entities.departments);

    for (const r of rows) {
      const plan = this.resolvePlan(r.externalId, planByExtId, input.decisions);
      if (plan === 'skip') {
        out.push({
          externalId: r.externalId,
          outcome: 'skipped',
          reason: 'user_choice',
        });
        continue;
      }
      try {
        const branchId = r.locationExternalId
          ? (locMap.get(r.locationExternalId) ?? null)
          : null;
        if (plan === 'will_update') {
          const matchedId = planByExtId.get(r.externalId)?.matchedId;
          if (!matchedId) throw new Error('update plan without matchedId');
          idMap.set(r.externalId, matchedId);
          const { error } = await this.supabase
            .from('departments')
            .update({ name: r.name, branch_id: branchId })
            .eq('id', matchedId)
            .eq('company_id', input.companyId);
          if (error) throw new Error(error.message);
          out.push({
            externalId: r.externalId,
            outcome: 'updated',
            id: matchedId,
          });
        } else {
          const id = randomUUID();
          const { error } = await this.supabase.from('departments').insert({
            id,
            company_id: input.companyId,
            name: r.name,
            branch_id: branchId,
          });
          if (error) throw new Error(error.message);
          idMap.set(r.externalId, id);
          out.push({ externalId: r.externalId, outcome: 'created', id });
        }
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  private async commitRoles(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    idMap: Map<string, string>,
  ): Promise<void> {
    const rows = input.payload.data.roles ?? [];
    const planByExtId = this.planMap(input.preview.entities.roles);

    for (const r of rows) {
      const plan = this.resolvePlan(r.externalId, planByExtId, input.decisions);
      if (plan === 'skip') {
        out.push({
          externalId: r.externalId,
          outcome: 'skipped',
          reason: 'user_choice',
        });
        continue;
      }
      try {
        // company_skills es link `(company_id, skill_id)`. El nombre vive
        // en `skills` (catálogo global UNIQUE por name). Flow correcto:
        //   1. Upsert skills(name) → skill_id (idempotente cross-tenant).
        //   2. Lookup company_skills(company_id, skill_id) — puede no
        //      existir, existir activo, o estar soft-deleted.
        //   3. Si no existe → INSERT. Si soft-deleted → revivir. Si
        //      activo → no-op.
        const normalized = r.name.trim();
        const { data: skillRows, error: skillErr } = await this.supabase
          .from('skills')
          .upsert({ name: normalized }, { onConflict: 'name' })
          .select('id')
          .limit(1);
        if (skillErr) throw new Error(`skills upsert: ${skillErr.message}`);
        const skillId = (skillRows ?? [])[0]?.id as string | undefined;
        if (!skillId) throw new Error('failed to upsert global skill');

        const { data: existing } = await this.supabase
          .from('company_skills')
          .select('id, deleted_at')
          .eq('company_id', input.companyId)
          .eq('skill_id', skillId)
          .limit(1)
          .maybeSingle();

        if (existing) {
          const linkId = existing.id as string;
          if (existing.deleted_at !== null) {
            const { error: reviveErr } = await this.supabase
              .from('company_skills')
              .update({ is_active: true, deleted_at: null })
              .eq('id', linkId);
            if (reviveErr) throw new Error(`revive: ${reviveErr.message}`);
          }
          idMap.set(r.externalId, linkId);
          out.push({
            externalId: r.externalId,
            outcome: 'updated',
            id: linkId,
          });
        } else {
          const id = randomUUID();
          const { error: insertErr } = await this.supabase
            .from('company_skills')
            .insert({
              id,
              company_id: input.companyId,
              skill_id: skillId,
            });
          if (insertErr) throw new Error(insertErr.message);
          idMap.set(r.externalId, id);
          out.push({ externalId: r.externalId, outcome: 'created', id });
        }
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  private async commitEmployees(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    idMap: Map<string, string>,
    deptMap: Map<string, string>,
    roleMap: Map<string, string>,
  ): Promise<void> {
    const rows = input.payload.data.employees ?? [];
    const planByExtId = this.planMap(input.preview.entities.employees);

    for (const r of rows) {
      const plan = this.resolvePlan(r.externalId, planByExtId, input.decisions);
      if (plan === 'skip') {
        out.push({
          externalId: r.externalId,
          outcome: 'skipped',
          reason: 'user_choice',
        });
        continue;
      }
      try {
        const deptId = r.departmentExternalId
          ? (deptMap.get(r.departmentExternalId) ?? null)
          : null;
        let employeeId: string;
        if (plan === 'will_update') {
          const matchedId = planByExtId.get(r.externalId)?.matchedId;
          if (!matchedId) throw new Error('update plan without matchedId');
          employeeId = matchedId;
          const { error } = await this.supabase
            .from('employees')
            .update({
              name: r.name,
              email: r.email ?? null,
              phone_number: r.phone ?? null,
              experience_months: r.experienceMonths ?? null,
              department_id: deptId,
            })
            .eq('id', matchedId)
            .eq('company_id', input.companyId);
          if (error) throw new Error(error.message);
          idMap.set(r.externalId, matchedId);
          out.push({
            externalId: r.externalId,
            outcome: 'updated',
            id: matchedId,
          });
        } else {
          employeeId = randomUUID();
          const { error } = await this.supabase.from('employees').insert({
            id: employeeId,
            company_id: input.companyId,
            name: r.name,
            email: r.email ?? null,
            phone_number: r.phone ?? null,
            experience_months: r.experienceMonths ?? 0,
            department_id: deptId,
            hire_date: r.hireDate ?? new Date().toISOString().split('T')[0],
            role: 'employee',
          });
          if (error) throw new Error(error.message);
          idMap.set(r.externalId, employeeId);
          out.push({
            externalId: r.externalId,
            outcome: 'created',
            id: employeeId,
          });
        }

        // Linkear roles → employee_skills. El payload trae
        // `roleExternalIds` que mapean a company_skill IDs en roleMap.
        // Insertamos con upsert defensivo: si el link ya existe, no-op.
        if (r.roleExternalIds && r.roleExternalIds.length > 0) {
          const skillLinks = r.roleExternalIds
            .map((rid) => roleMap.get(rid))
            .filter((id): id is string => !!id)
            .map((companySkillId) => ({
              employee_id: employeeId,
              company_skill_id: companySkillId,
              level: 'beginner' as const,
            }));
          if (skillLinks.length > 0) {
            const { error: linkErr } = await this.supabase
              .from('employee_skills')
              .upsert(skillLinks, {
                onConflict: 'employee_id,company_skill_id',
                ignoreDuplicates: true,
              });
            if (linkErr) {
              // No falla el employee — solo loguea. El link es "best
              // effort" en Fase 1; el manager puede agregarlos
              // manualmente desde /workforce/skills después.
              this.logger.warn(
                `Employee ${r.externalId}: failed to link skills — ${linkErr.message}`,
              );
            }
          }
        }
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private planMap(rows: PreviewRow[]): Map<string, PreviewRow> {
    return new Map(rows.map((r) => [r.externalId, r]));
  }

  private resolvePlan(
    externalId: string,
    previewPlans: Map<string, PreviewRow>,
    decisions?: Record<string, 'create' | 'update' | 'skip'>,
  ): 'will_create' | 'will_update' | 'skip' {
    const userDecision = decisions?.[externalId];
    if (userDecision === 'skip') return 'skip';
    if (userDecision === 'create') return 'will_create';
    if (userDecision === 'update') return 'will_update';
    const row = previewPlans.get(externalId);
    if (!row) return 'will_create';
    if (row.blockedByError) return 'skip';
    if (row.plan === 'unresolved') return 'skip';
    return row.plan === 'will_update' ? 'will_update' : 'will_create';
  }

  private skipAll(
    rows: Array<{ externalId: string }>,
    out: CommitRowOutcome[],
    reason: string,
  ): void {
    for (const r of rows) {
      out.push({ externalId: r.externalId, outcome: 'skipped', reason });
    }
  }

  private computeTotals(
    entities: CommitReport['entities'],
  ): CommitReport['totals'] {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const list of Object.values(entities)) {
      for (const r of list) {
        if (r.outcome === 'created') created++;
        else if (r.outcome === 'updated') updated++;
        else if (r.outcome === 'skipped') skipped++;
        else failed++;
      }
    }
    return { created, updated, skipped, failed };
  }
}
