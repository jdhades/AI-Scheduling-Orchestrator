import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import type {
  ImportPayload,
  ImportShift,
  ImportAvailability,
  ImportTimeOff,
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
    /**
     * Fase 5 — magic import: derivadas post-commit, una por par único
     * (employee, template). El externalId es sintético: "memb:<emp>:<tpl>".
     */
    memberships: CommitRowOutcome[];
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
        memberships: [],
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
      shifts: new Map<string, string>(),
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

    // Fase 4: shifts → breaks (shift_specific) → availability → timeOff.
    // Orden por FK: breaks dependen del assignment_id de shifts; el resto
    // solo necesita employee_id.
    // Cache de tiempos del assignment para que commitBreaks no tenga
    // que volver a SELECTear shift_assignments por cada break (cuello
    // de botella: 64 shifts × 1 select extra = 64 round-trips evitados).
    const assignmentTimes = new Map<
      string,
      { start: Date; end: Date }
    >();

    // Fase 5 (magic import): tracking de (employee, template, date) por cada
    // shift commiteado. Se agrupa post-shifts para derivar memberships.
    const shiftRecords: Array<{
      employeeId: string;
      templateId: string;
      date: string;
    }> = [];

    await this.commitShifts(
      input,
      report.entities.shifts,
      idMaps.shifts,
      idMaps.employees,
      idMaps.roles,
      idMaps.locations,
      idMaps.departments,
      assignmentTimes,
      shiftRecords,
    );
    await this.commitBreaks(
      input,
      report.entities.breaks,
      idMaps.shifts,
      idMaps.roles,
      assignmentTimes,
    );
    await this.commitAvailability(
      input,
      report.entities.availability,
      idMaps.employees,
    );
    await this.commitTimeOff(
      input,
      report.entities.timeOff,
      idMaps.employees,
    );
    await this.commitMemberships(
      input,
      report.entities.memberships,
      shiftRecords,
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
    if (rows.length === 0) return;
    const planByExtId = this.planMap(input.preview.entities.departments);

    // departments.branch_id es NOT NULL. Si el payload no trae locations
    // (típico en archivos chicos: roster sin sucursales), buscamos la
    // primera branch existente del tenant. Si tampoco hay ninguna,
    // auto-creamos una "Main" — esto desbloquea el caso pyme de "1
    // local sin nombre" sin obligar al owner a crear branches primero.
    const fallbackBranchId = await this.ensureFallbackBranch(
      input.companyId,
      locMap.size > 0,
    );

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
          ? (locMap.get(r.locationExternalId) ?? fallbackBranchId)
          : fallbackBranchId;
        if (!branchId) {
          throw new Error(
            'department needs a branch but none could be resolved or created',
          );
        }
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

  // ── Fase 4: shifts / availability / breaks / time-off ────────────

  /**
   * Commit shifts → shift_assignments. Cada shift necesita un
   * `template_id`; buscamos un shift_template por
   * (company_id, name, day_of_week, start_time, end_time) y si no
   * existe lo creamos sobre la marcha. Origin='override' porque el
   * import es manual (no derivado de un membership).
   */
  private async commitShifts(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    shiftMap: Map<string, string>,
    empMap: Map<string, string>,
    roleMap: Map<string, string>,
    // locMap: el schema V3 actual no tiene branch_id ni en
    // shift_assignments ni en shift_templates — el branch se infiere
    // del employee. Lo dejamos en la firma por si en el futuro sumamos
    // location-aware templates.
    _locMap: Map<string, string>,
    deptMap: Map<string, string>,
    assignmentTimes: Map<string, { start: Date; end: Date }>,
    shiftRecords: Array<{
      employeeId: string;
      templateId: string;
      date: string;
    }>,
  ): Promise<void> {
    const rows = input.payload.data.shifts ?? [];
    const planByExtId = this.planMap(input.preview.entities.shifts);

    // Cache local: (templateKey) → template_id. Evita lookups repetidos
    // dentro del mismo commit cuando el import trae 64 shifts con el
    // mismo template.
    const templateCache = new Map<string, string>();

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
        if (!r.employeeExternalId) {
          throw new Error(
            'Open shifts (without employee) not supported in import yet',
          );
        }
        const employeeId = empMap.get(r.employeeExternalId);
        if (!employeeId) {
          throw new Error(
            `employee "${r.employeeExternalId}" not found in payload or DB`,
          );
        }
        const dayOfWeek = this.dayOfWeekFromIsoDate(r.date);
        const templateId = await this.resolveShiftTemplate(
          {
            companyId: input.companyId,
            name: r.templateName ?? this.deriveTemplateName(r),
            dayOfWeek,
            startTime: r.startTime,
            endTime: r.endTime,
            requiredRoleExternalId: r.requiredRoleExternalId,
            departmentExternalId: r.departmentExternalId,
            roleMap,
            deptMap,
          },
          templateCache,
        );

        const { startTs, endTs } = this.computeAssignmentTimes(
          r.date,
          r.startTime,
          r.endTime,
          r.crossesMidnight,
        );

        const id = randomUUID();
        const { error } = await this.supabase
          .from('shift_assignments')
          .insert({
            id,
            company_id: input.companyId,
            template_id: templateId,
            employee_id: employeeId,
            date: r.date,
            origin: 'override',
            actual_start_time: startTs,
            actual_end_time: endTs,
          });
        if (error) throw new Error(error.message);
        shiftMap.set(r.externalId, id);
        assignmentTimes.set(id, {
          start: new Date(startTs),
          end: new Date(endTs),
        });
        shiftRecords.push({
          employeeId,
          templateId,
          date: r.date,
        });
        out.push({ externalId: r.externalId, outcome: 'created', id });
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  private async resolveShiftTemplate(
    args: {
      companyId: string;
      name: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      requiredRoleExternalId?: string;
      /** El schema V3 tiene department_id en shift_templates (no en
       *  shift_assignments). Se usa para el filtro del schedule grid. */
      departmentExternalId?: string;
      roleMap: Map<string, string>;
      deptMap: Map<string, string>;
    },
    cache: Map<string, string>,
  ): Promise<string> {
    // Normalize HH:mm → HH:mm:ss for TIME comparison.
    const start = this.normalizeTime(args.startTime);
    const end = this.normalizeTime(args.endTime);
    // Match templates ignorando day_of_week: el grid del roster típicamente
    // tiene el mismo turno aplicado a varios días, y cada (employee, date)
    // ya vive en shift_assignments. Sumar day_of_week al match generaría
    // 7 templates clónicos por cada tipo (Retail Diurno × 7 días = 7 rows
    // idénticas en /workforce/templates), que es la queja del owner.
    // day_of_week en shift_templates queda como metadata (NOT NULL del
    // schema V3, se setea al day_of_week del primer assignment que
    // genere el template; semánticamente la columna pierde significado
    // para templates importados).
    const cacheKey = `${args.name}|${start}|${end}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data: existing } = await this.supabase
      .from('shift_templates')
      .select('id')
      .eq('company_id', args.companyId)
      .eq('name', args.name)
      .eq('start_time', start)
      .eq('end_time', end)
      .limit(1)
      .maybeSingle();
    if (existing) {
      cache.set(cacheKey, existing.id as string);
      return existing.id as string;
    }

    const requiredSkillId = args.requiredRoleExternalId
      ? (args.roleMap.get(args.requiredRoleExternalId) ?? null)
      : null;
    const departmentId = args.departmentExternalId
      ? (args.deptMap.get(args.departmentExternalId) ?? null)
      : null;
    const id = randomUUID();
    const { error } = await this.supabase.from('shift_templates').insert({
      id,
      company_id: args.companyId,
      name: args.name,
      day_of_week: args.dayOfWeek,
      start_time: start,
      end_time: end,
      required_skill_id: requiredSkillId,
      department_id: departmentId,
      is_active: true,
    });
    if (error) {
      throw new Error(`shift_template insert: ${error.message}`);
    }
    cache.set(cacheKey, id);
    return id;
  }

  /**
   * Commit shift_assignment_breaks. Solo procesa scope='shift_specific'
   * porque necesita el assignment_id. Para 'policy_global'/'policy_role'
   * dejamos skipped con reason específica: esas reglas viven en el
   * subsistema de CompanyPolicy y este import no es el path adecuado.
   */
  private async commitBreaks(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    shiftMap: Map<string, string>,
    _roleMap: Map<string, string>,
    assignmentTimes: Map<string, { start: Date; end: Date }>,
  ): Promise<void> {
    const rows = input.payload.data.breaks ?? [];
    const planByExtId = this.planMap(input.preview.entities.breaks);

    for (const r of rows) {
      if (r.scope !== 'shift_specific') {
        out.push({
          externalId: r.externalId,
          outcome: 'skipped',
          reason: 'policy_scope_belongs_to_company_policies',
        });
        continue;
      }
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
        if (!r.shiftExternalId) {
          throw new Error('shift_specific break missing shiftExternalId');
        }
        const assignmentId = shiftMap.get(r.shiftExternalId);
        if (!assignmentId) {
          throw new Error(
            `shift "${r.shiftExternalId}" not found in committed shifts`,
          );
        }
        const times = assignmentTimes.get(assignmentId);
        if (!times) {
          throw new Error(
            `assignment ${assignmentId} missing in cache — shift commit may have failed`,
          );
        }
        const { startTs, endTs } = this.computeBreakWindow(
          times,
          r.triggerAfterMinutesWorked,
          r.durationMinutes,
        );
        const id = randomUUID();
        const { error } = await this.supabase
          .from('shift_assignment_breaks')
          .insert({
            id,
            assignment_id: assignmentId,
            company_id: input.companyId,
            start_time: startTs,
            end_time: endTs,
            is_paid: r.isPaid,
            reason: null,
          });
        if (error) throw new Error(error.message);
        out.push({ externalId: r.externalId, outcome: 'created', id });
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Commit availability windows → employee_availability rows. Cada
   * ImportAvailability tiene N windows; cada window con `available=true`
   * genera 1 row. windows con `available=false` se omiten (la tabla
   * solo modela ventanas en las que SÍ se puede trabajar).
   *
   * Cross-midnight: la tabla tiene CHECK (end_time > start_time) — los
   * windows que cruzan medianoche se splittean en 2 rows (22:00→23:59
   * + 00:00→06:00) para satisfacer el constraint.
   */
  private async commitAvailability(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    empMap: Map<string, string>,
  ): Promise<void> {
    const rows = input.payload.data.availability ?? [];
    const planByExtId = this.planMap(input.preview.entities.availability);

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
        const employeeId = empMap.get(r.employeeExternalId);
        if (!employeeId) {
          throw new Error(
            `employee "${r.employeeExternalId}" not found in payload or DB`,
          );
        }
        const insertRows = this.expandAvailabilityWindows(
          r,
          employeeId,
        );
        if (insertRows.length === 0) {
          out.push({
            externalId: r.externalId,
            outcome: 'skipped',
            reason: 'no_available_windows',
          });
          continue;
        }
        const { error } = await this.supabase
          .from('employee_availability')
          .insert(insertRows);
        if (error) throw new Error(error.message);
        // Devolvemos el id del primer row insertado (la entidad lógica
        // del import es la availability completa, los rows en DB son
        // su descomposición).
        out.push({
          externalId: r.externalId,
          outcome: 'created',
          id: insertRows[0].id,
        });
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  private expandAvailabilityWindows(
    r: ImportAvailability,
    employeeId: string,
  ): Array<{
    id: string;
    employee_id: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
  }> {
    const out: Array<{
      id: string;
      employee_id: string;
      day_of_week: number;
      start_time: string;
      end_time: string;
    }> = [];
    for (const w of r.windows) {
      if (!w.available) continue;
      const start = this.normalizeTime(w.startTime);
      const end = this.normalizeTime(w.endTime);
      if (end > start) {
        out.push({
          id: randomUUID(),
          employee_id: employeeId,
          day_of_week: r.dayOfWeek,
          start_time: start,
          end_time: end,
        });
      } else {
        // Cross-midnight: 22:00 → 06:00 split en 2 rows
        // (22:00 → 23:59:59 del mismo día, 00:00 → 06:00 del día siguiente).
        out.push({
          id: randomUUID(),
          employee_id: employeeId,
          day_of_week: r.dayOfWeek,
          start_time: start,
          end_time: '23:59:59',
        });
        const nextDay = (r.dayOfWeek + 1) % 7;
        out.push({
          id: randomUUID(),
          employee_id: employeeId,
          day_of_week: nextDay,
          start_time: '00:00:00',
          end_time: end,
        });
      }
    }
    return out;
  }

  /**
   * Commit time-off. Expande el rango [startDate, endDate] a una row
   * por día en day_off_requests. El status se respeta tal cual del
   * import; reason puede venir explícito o se deriva del type.
   */
  private async commitTimeOff(
    input: {
      payload: ImportPayload;
      companyId: string;
      preview: PreviewResult;
      decisions?: Record<string, 'create' | 'update' | 'skip'>;
    },
    out: CommitRowOutcome[],
    empMap: Map<string, string>,
  ): Promise<void> {
    const rows = input.payload.data.timeOff ?? [];
    const planByExtId = this.planMap(input.preview.entities.timeOff);

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
        const employeeId = empMap.get(r.employeeExternalId);
        if (!employeeId) {
          throw new Error(
            `employee "${r.employeeExternalId}" not found in payload or DB`,
          );
        }
        const dates = this.expandDateRange(r.startDate, r.endDate);
        if (dates.length === 0) {
          out.push({
            externalId: r.externalId,
            outcome: 'failed',
            error: `invalid date range ${r.startDate} → ${r.endDate}`,
          });
          continue;
        }
        const reason = r.reason ?? this.deriveTimeOffReason(r.type);
        const insertRows = dates.map((d) => ({
          id: randomUUID(),
          company_id: input.companyId,
          employee_id: employeeId,
          date: d,
          reason,
          status: r.status,
        }));
        const { error } = await this.supabase
          .from('day_off_requests')
          .insert(insertRows);
        if (error) throw new Error(error.message);
        out.push({
          externalId: r.externalId,
          outcome: 'created',
          id: insertRows[0].id,
        });
      } catch (err) {
        out.push({
          externalId: r.externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Fase 5 (magic import). Después de commit-ear todos los shifts, agrupa
   * los assignments creados por (employee, template) y genera una
   * shift_membership por cada par único:
   *   effective_from = min(date) del grupo
   *   effective_until = null (open-ended → Generate la usa para semanas
   *                            futuras)
   *
   * Idempotencia: el UNIQUE (employee_id, template_id, effective_from)
   * de la tabla evita duplicados si reimportás con la misma fecha de
   * inicio. Si el INSERT falla por conflict, lo marcamos como
   * skipped/'already_exists' — el owner ya tenía esa membership.
   */
  private async commitMemberships(
    input: { companyId: string },
    out: CommitRowOutcome[],
    shiftRecords: Array<{
      employeeId: string;
      templateId: string;
      date: string;
    }>,
  ): Promise<void> {
    if (shiftRecords.length === 0) return;

    const grouped = new Map<
      string,
      { employeeId: string; templateId: string; firstDate: string }
    >();
    for (const r of shiftRecords) {
      const key = `${r.employeeId}|${r.templateId}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          employeeId: r.employeeId,
          templateId: r.templateId,
          firstDate: r.date,
        });
      } else if (r.date < existing.firstDate) {
        existing.firstDate = r.date;
      }
    }

    for (const { employeeId, templateId, firstDate } of grouped.values()) {
      // externalId sintético — útil para que aparezca en el commit
      // report con un identificador estable.
      const externalId = `memb:${employeeId.slice(0, 8)}:${templateId.slice(0, 8)}`;
      try {
        const id = randomUUID();
        const { error } = await this.supabase
          .from('shift_memberships')
          .insert({
            id,
            company_id: input.companyId,
            employee_id: employeeId,
            template_id: templateId,
            effective_from: firstDate,
            effective_until: null,
          });
        if (error) {
          // Postgres unique_violation = 23505
          const code = (error as { code?: string }).code;
          if (
            code === '23505' ||
            error.message.includes('duplicate') ||
            error.message.includes('unique')
          ) {
            out.push({
              externalId,
              outcome: 'skipped',
              reason: 'already_exists',
            });
            continue;
          }
          throw new Error(error.message);
        }
        out.push({ externalId, outcome: 'created', id });
      } catch (err) {
        out.push({
          externalId,
          outcome: 'failed',
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Resuelve un branch_id "fallback" para inserts de departments cuando
   * el payload no trae locations. Estrategia:
   *   1. Si el payload SÍ tiene locations → null (los dept usan locMap).
   *   2. Si no hay locations en el payload, buscar la primera branch
   *      existente del tenant (no soft-deleted).
   *   3. Si tampoco hay → auto-crear una branch "Main" (caso pyme,
   *      single-location).
   *
   * Devuelve el branch_id a usar o null si decidimos no fallback-ear.
   */
  private async ensureFallbackBranch(
    companyId: string,
    payloadHasLocations: boolean,
  ): Promise<string | null> {
    if (payloadHasLocations) {
      return null;
    }
    const { data: existing } = await this.supabase
      .from('branches')
      .select('id')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return existing.id as string;
    }
    // Sin branches: auto-crear "Main".
    const id = randomUUID();
    const { error } = await this.supabase.from('branches').insert({
      id,
      company_id: companyId,
      name: 'Main',
      timezone: null,
    });
    if (error) {
      this.logger.warn(
        `Failed to auto-create fallback branch: ${error.message}`,
      );
      return null;
    }
    this.logger.log(
      `Auto-created fallback branch "Main" (${id}) for company ${companyId}`,
    );
    return id;
  }

  // ── Helpers de Fase 4 ─────────────────────────────────────────────

  private dayOfWeekFromIsoDate(isoDate: string): number {
    // Construimos con T12:00:00 UTC para evitar saltos por timezone al
    // calcular el día de la semana. ISO YYYY-MM-DD asume calendario gregoriano.
    const d = new Date(`${isoDate}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`invalid ISO date: ${isoDate}`);
    }
    return d.getUTCDay(); // 0=Sun..6=Sat
  }

  private normalizeTime(hhmm: string): string {
    // Acepta "HH:mm" o "HH:mm:ss"; devuelve siempre "HH:mm:ss" para que
    // los CHECK constraints de TIME comparen string-igual a igual.
    if (/^\d{2}:\d{2}$/.test(hhmm)) return `${hhmm}:00`;
    if (/^\d{2}:\d{2}:\d{2}$/.test(hhmm)) return hhmm;
    throw new Error(`invalid time format: ${hhmm}`);
  }

  private computeAssignmentTimes(
    date: string,
    startTime: string,
    endTime: string,
    crossesMidnight: boolean,
  ): { startTs: string; endTs: string } {
    const startTs = `${date}T${this.normalizeTime(startTime)}Z`;
    if (!crossesMidnight) {
      return {
        startTs,
        endTs: `${date}T${this.normalizeTime(endTime)}Z`,
      };
    }
    // Sumar 1 día al endDate
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDate = d.toISOString().slice(0, 10);
    return {
      startTs,
      endTs: `${nextDate}T${this.normalizeTime(endTime)}Z`,
    };
  }

  /**
   * Calcula start/end del break dentro de la ventana de un assignment
   * usando los tiempos que ya teníamos en memoria desde commitShifts.
   * Si no viene triggerAfterMinutesWorked, ponemos el break a mitad
   * del turno como aproximación razonable.
   */
  private computeBreakWindow(
    times: { start: Date; end: Date },
    triggerAfterMinutes: number | undefined,
    durationMinutes: number,
  ): { startTs: string; endTs: string } {
    const { start, end } = times;
    const shiftMinutes = (end.getTime() - start.getTime()) / 60000;
    const offset =
      triggerAfterMinutes ?? Math.max(0, Math.floor(shiftMinutes / 2));
    const breakStart = new Date(start.getTime() + offset * 60000);
    const breakEnd = new Date(breakStart.getTime() + durationMinutes * 60000);
    // Clamp al fin del turno por seguridad — si el break se pasa, lo
    // recortamos sin error.
    const safeEnd = breakEnd > end ? end : breakEnd;
    if (safeEnd <= breakStart) {
      throw new Error('computed break window is empty');
    }
    return {
      startTs: breakStart.toISOString(),
      endTs: safeEnd.toISOString(),
    };
  }

  private deriveTemplateName(r: ImportShift): string {
    return `Imported ${r.startTime}-${r.endTime}`;
  }

  private deriveTimeOffReason(type: ImportTimeOff['type']): string {
    switch (type) {
      case 'vacation':
        return 'Vacation';
      case 'sick':
        return 'Sick leave';
      case 'personal':
        return 'Personal time';
      case 'unpaid':
        return 'Unpaid leave';
      case 'other':
      default:
        return 'Time off';
    }
  }

  private expandDateRange(startIso: string, endIso: string): string[] {
    const start = new Date(`${startIso}T00:00:00Z`);
    const end = new Date(`${endIso}T00:00:00Z`);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      return [];
    }
    const out: string[] = [];
    const cur = new Date(start);
    while (cur <= end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
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
