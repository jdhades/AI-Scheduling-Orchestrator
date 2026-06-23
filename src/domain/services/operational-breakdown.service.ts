import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { IEmployeeRepository } from '../repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../repositories/employee.repository';
import type { IShiftTemplateRepository } from '../repositories/shift-template.repository';
import type { IShiftAssignmentRepository } from '../repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../repositories/shift-assignment.repository';
import {
  FAIRNESS_HISTORY_REPOSITORY,
  type IFairnessHistoryRepository,
} from '../repositories/fairness-history.repository';
import type { ShiftTemplate } from '../aggregates/shift-template.aggregate';
import { weekStartOf, type WeekStartsOn } from '../shared/week';

// ─── DTOs ─────────────────────────────────────────────────────────────

export interface DepartmentBreakdownRow {
  id: string;
  name: string;
  employeeCount: number;
  coverageAvgPercent: number | null;
  unfilledShifts: number;
  fairnessCv: number | null;
  avgHoursPerEmployee: number | null;
}

export interface EmployeeBreakdownRow {
  id: string;
  name: string;
  departmentId: string | null;
  hoursWorked: number;
  /** Delta de hoursWorked vs el promedio del tenant (negativo = under, positivo = over). */
  hoursVsMean: number;
  absenceCount: number;
  swapCount: number;
  dayOffCount: number;
  /**
   * Score composite [0-100]. 100 = perfecto (sin ausencias ni cambios).
   * Penalización: cada ausencia -10pts, cada swap -3pts, cada day-off -2pts.
   * Capped en [0, 100]. NO es predictivo, es ranking simple.
   */
  reliabilityScore: number;
}

export interface TemplateBreakdownRow {
  id: string;
  name: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** Instancias del template en el período (1 por semana cuando dayOfWeek está fijado). */
  instancesCount: number;
  /** required_employees del template (constante). */
  required: number;
  /** Promedio de empleados asignados por instancia. */
  avgAssigned: number | null;
  /** % de instancias donde assigned >= required. */
  fillRate: number | null;
  /** Cambios manuales detectados en entity_audit_log para assignments de este template. */
  manualModifications: number;
}

export interface CrossCuttingMetrics {
  generations: {
    fromWhatsapp: number;
    fromPanel: number;
    total: number;
    whatsappShare: number | null;
  };
  whatsappLlm: {
    classifyTextCalls: number;
    classifyAudioCalls: number;
    totalTokens: number;
  };
  /** % de assignments modificadas manualmente (entity_audit_log con action=update) tras la generación. */
  scheduleChurnPercent: number | null;
}

// ─── Service ──────────────────────────────────────────────────────────

@Injectable()
export class OperationalBreakdownService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepo: IFairnessHistoryRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  // ─── byDepartment ───────────────────────────────────────────────────

  async byDepartment(
    companyId: string,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): Promise<DepartmentBreakdownRow[]> {
    const { from, to } = this._dateRange(weekStarts);
    const [deptsRes, employees, templates, fairness] = await Promise.all([
      this.supabase
        .from('departments')
        .select('id, name')
        .eq('company_id', companyId)
        .order('name'),
      this.employeeRepo.findAllByCompany(companyId),
      this.templateRepo.findAllByCompany(companyId),
      this._fetchFairnessForWeeks(companyId, weekStarts),
    ]);
    if (deptsRes.error) {
      throw new Error(`byDepartment failed: ${deptsRes.error.message}`);
    }
    const depts = (deptsRes.data ?? []) as Array<{ id: string; name: string }>;
    const activeTemplates = templates.filter((t) => t.isActive);
    const assignments = await this.assignmentRepo.findByCompanyAndDateRange(
      companyId,
      from,
      to,
    );

    return depts.map((d) => {
      const deptEmployees = employees.filter((e) => e.departmentId === d.id);
      const deptTemplateIds = new Set(
        activeTemplates.filter((t) => t.departmentId === d.id).map((t) => t.id),
      );
      const deptTemplates = activeTemplates.filter(
        (t) => t.departmentId === d.id,
      );
      const deptAssignments = assignments.filter((a) =>
        deptTemplateIds.has(a.templateId),
      );
      const deptFairness = fairness.filter((f) =>
        deptEmployees.some((e) => e.id === f.employeeId),
      );
      const coverage = this._computeCoverageStats(
        deptTemplates,
        deptAssignments,
        weekStarts,
        weekStartsOn,
      );
      const fairnessCv = this._computeFairnessCv(deptFairness);
      const totalHours = deptFairness.reduce(
        (acc, f) => acc + f.hoursWorked,
        0,
      );
      const avgHoursPerEmployee =
        deptEmployees.length > 0
          ? Math.round((totalHours / deptEmployees.length) * 10) / 10
          : null;
      return {
        id: d.id,
        name: d.name,
        employeeCount: deptEmployees.length,
        coverageAvgPercent: coverage.avgPercent,
        unfilledShifts: coverage.unfilledShifts,
        fairnessCv,
        avgHoursPerEmployee,
      };
    });
  }

  // ─── byEmployee ─────────────────────────────────────────────────────

  async byEmployee(
    companyId: string,
    weekStarts: string[],
    _weekStartsOn: WeekStartsOn,
  ): Promise<EmployeeBreakdownRow[]> {
    const { from, to } = this._dateRange(weekStarts);
    const [employees, fairness, swapRes, dayOffRes, absenceRes] =
      await Promise.all([
        this.employeeRepo.findAllByCompany(companyId),
        this._fetchFairnessForWeeks(companyId, weekStarts),
        this.supabase
          .from('shift_swap_requests')
          .select('requester_id')
          .eq('company_id', companyId)
          .gte('created_at', `${from}T00:00:00.000Z`)
          .lte('created_at', `${to}T23:59:59.999Z`),
        this.supabase
          .from('day_off_requests')
          .select('employee_id')
          .eq('company_id', companyId)
          .is('deleted_at', null)
          .gte('created_at', `${from}T00:00:00.000Z`)
          .lte('created_at', `${to}T23:59:59.999Z`),
        this.supabase
          .from('absence_reports')
          .select('employee_id')
          .eq('company_id', companyId)
          .is('deleted_at', null)
          .gte('start_date', from)
          .lte('start_date', to),
      ]);

    const hoursByEmp = new Map<string, number>();
    for (const f of fairness) {
      hoursByEmp.set(
        f.employeeId,
        (hoursByEmp.get(f.employeeId) ?? 0) + f.hoursWorked,
      );
    }
    const allHours = Array.from(hoursByEmp.values()).filter((h) => h > 0);
    const meanHours =
      allHours.length > 0
        ? allHours.reduce((a, b) => a + b, 0) / allHours.length
        : 0;

    const swapCountByEmp = this._countByKey(
      swapRes.data ?? [],
      (row: any) => row.requester_id,
    );
    const dayOffCountByEmp = this._countByKey(
      dayOffRes.data ?? [],
      (row: any) => row.employee_id,
    );
    const absenceCountByEmp = this._countByKey(
      absenceRes.data ?? [],
      (row: any) => row.employee_id,
    );

    return employees.map((e) => {
      const hoursWorked = hoursByEmp.get(e.id) ?? 0;
      const absenceCount = absenceCountByEmp.get(e.id) ?? 0;
      const swapCount = swapCountByEmp.get(e.id) ?? 0;
      const dayOffCount = dayOffCountByEmp.get(e.id) ?? 0;
      const reliabilityScore = Math.max(
        0,
        Math.min(
          100,
          100 - absenceCount * 10 - swapCount * 3 - dayOffCount * 2,
        ),
      );
      return {
        id: e.id,
        name: e.name,
        departmentId: e.departmentId ?? null,
        hoursWorked: Math.round(hoursWorked * 10) / 10,
        hoursVsMean: Math.round((hoursWorked - meanHours) * 10) / 10,
        absenceCount,
        swapCount,
        dayOffCount,
        reliabilityScore,
      };
    });
  }

  // ─── byTemplate ─────────────────────────────────────────────────────

  async byTemplate(
    companyId: string,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): Promise<TemplateBreakdownRow[]> {
    const { from, to } = this._dateRange(weekStarts);
    const [templates, assignments, auditRes] = await Promise.all([
      this.templateRepo.findAllByCompany(companyId),
      this.assignmentRepo.findByCompanyAndDateRange(companyId, from, to),
      this.supabase
        .from('entity_audit_log')
        .select('entity_id, action, changes')
        .eq('company_id', companyId)
        .eq('entity_type', 'shift_assignment')
        .eq('action', 'update')
        .gte('changed_at', `${from}T00:00:00.000Z`)
        .lte('changed_at', `${to}T23:59:59.999Z`),
    ]);
    const activeTemplates = templates.filter((t) => t.isActive);

    // assignmentId → templateId para mapear audit log a templates.
    const tplByAssignmentId = new Map(
      assignments.map((a) => [a.id, a.templateId]),
    );
    const auditCountByTpl = new Map<string, number>();
    for (const row of (auditRes.data ?? []) as Array<{ entity_id: string }>) {
      const tplId = tplByAssignmentId.get(row.entity_id);
      if (tplId) {
        auditCountByTpl.set(tplId, (auditCountByTpl.get(tplId) ?? 0) + 1);
      }
    }

    return activeTemplates.map((tpl) => {
      // Instancias del template en las semanas pedidas: 1 por week donde
      // el dayOfWeek cae dentro del rango (asumiendo dayOfWeek fijo).
      const dates = this._templateInstanceDates(tpl, weekStarts, weekStartsOn);
      const instancesCount = dates.length;
      const required = tpl.requiredEmployees ?? 0;
      const assignedByDate = new Map<string, number>();
      for (const a of assignments) {
        if (a.templateId !== tpl.id) continue;
        if (!dates.includes(a.date)) continue;
        assignedByDate.set(a.date, (assignedByDate.get(a.date) ?? 0) + 1);
      }
      const filled = dates.filter(
        (d) => required > 0 && (assignedByDate.get(d) ?? 0) >= required,
      ).length;
      const totalAssigned = Array.from(assignedByDate.values()).reduce(
        (a, b) => a + b,
        0,
      );
      const avgAssigned =
        instancesCount > 0
          ? Math.round((totalAssigned / instancesCount) * 10) / 10
          : null;
      const fillRate =
        required > 0 && instancesCount > 0
          ? Math.round((filled / instancesCount) * 1000) / 10
          : null;
      return {
        id: tpl.id,
        name: tpl.name,
        dayOfWeek: tpl.dayOfWeek,
        startTime: tpl.startTime,
        endTime: tpl.endTime,
        instancesCount,
        required,
        avgAssigned,
        fillRate,
        manualModifications: auditCountByTpl.get(tpl.id) ?? 0,
      };
    });
  }

  // ─── crossCutting ───────────────────────────────────────────────────

  async crossCutting(
    companyId: string,
    weekStarts: string[],
    _weekStartsOn: WeekStartsOn,
  ): Promise<CrossCuttingMetrics> {
    const { from, to } = this._dateRange(weekStarts);
    const [runsRes, llmRes, assignmentsCountRes, auditCountRes] =
      await Promise.all([
        this.supabase
          .from('schedule_generation_runs')
          .select('source')
          .eq('company_id', companyId)
          .in('week_start', weekStarts.length > 0 ? weekStarts : ['']),
        this.supabase
          .from('llm_usage_log')
          .select('operation, total_tokens')
          .eq('company_id', companyId)
          .gte('created_at', `${from}T00:00:00.000Z`)
          .lte('created_at', `${to}T23:59:59.999Z`),
        this.assignmentRepo.findByCompanyAndDateRange(companyId, from, to),
        this.supabase
          .from('entity_audit_log')
          .select('entity_id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('entity_type', 'shift_assignment')
          .eq('action', 'update')
          .gte('changed_at', `${from}T00:00:00.000Z`)
          .lte('changed_at', `${to}T23:59:59.999Z`),
      ]);

    const runs = (runsRes.data ?? []) as Array<{ source: string }>;
    const fromWhatsapp = runs.filter((r) => r.source === 'whatsapp').length;
    const fromPanel = runs.filter((r) => r.source === 'http').length;
    const totalRuns = fromWhatsapp + fromPanel;
    const whatsappShare =
      totalRuns > 0 ? Math.round((fromWhatsapp / totalRuns) * 1000) / 10 : null;

    let classifyTextCalls = 0;
    let classifyAudioCalls = 0;
    let totalTokens = 0;
    for (const row of (llmRes.data ?? []) as Array<{
      operation: string;
      total_tokens: number;
    }>) {
      if (row.operation === 'whatsapp_classify') {
        classifyTextCalls++;
        totalTokens += row.total_tokens ?? 0;
      } else if (row.operation === 'whatsapp_classify_audio') {
        classifyAudioCalls++;
        totalTokens += row.total_tokens ?? 0;
      }
    }

    const totalAssignments = (assignmentsCountRes ?? []).length;
    const auditCount = auditCountRes.count ?? 0;
    const scheduleChurnPercent =
      totalAssignments > 0
        ? Math.round((auditCount / totalAssignments) * 1000) / 10
        : null;

    return {
      generations: { fromWhatsapp, fromPanel, total: totalRuns, whatsappShare },
      whatsappLlm: { classifyTextCalls, classifyAudioCalls, totalTokens },
      scheduleChurnPercent,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private _dateRange(weekStarts: string[]): { from: string; to: string } {
    if (weekStarts.length === 0) {
      return { from: '1970-01-01', to: '1970-01-01' };
    }
    const sorted = [...weekStarts].sort();
    const from = sorted[0];
    const lastStart = sorted[sorted.length - 1];
    const lastDate = new Date(`${lastStart}T00:00:00.000Z`);
    lastDate.setUTCDate(lastDate.getUTCDate() + 6);
    const to = lastDate.toISOString().slice(0, 10);
    return { from, to };
  }

  private async _fetchFairnessForWeeks(
    companyId: string,
    weekStarts: string[],
  ) {
    const allRows = await Promise.all(
      weekStarts.map((ws) =>
        this.fairnessRepo.findByWeek(
          companyId,
          new Date(`${ws}T00:00:00.000Z`),
        ),
      ),
    );
    return allRows.flat();
  }

  private _countByKey<T>(
    rows: T[],
    keyFn: (row: T) => string | null | undefined,
  ): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of rows) {
      const key = keyFn(row);
      if (!key) continue;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  }

  private _computeFairnessCv(
    fairness: Array<{ hoursWorked: number; employeeId: string }>,
  ): number | null {
    // Suma de horas por empleado (puede haber múltiples weeks).
    const byEmp = new Map<string, number>();
    for (const f of fairness) {
      byEmp.set(f.employeeId, (byEmp.get(f.employeeId) ?? 0) + f.hoursWorked);
    }
    const hours = Array.from(byEmp.values()).filter((h) => h > 0);
    if (hours.length === 0) return null;
    const mean = hours.reduce((a, b) => a + b, 0) / hours.length;
    if (mean === 0) return null;
    const variance =
      hours.reduce((acc, h) => acc + (h - mean) ** 2, 0) / hours.length;
    const stdDev = Math.sqrt(variance);
    return Math.round((stdDev / mean) * 100 * 10) / 10;
  }

  /**
   * Subset de la lógica de CoverageService — para evitar leakage del concepto
   * `dept` al servicio principal. Computa avg% + unfilled sobre todas las
   * (template × instancia) del dept.
   */
  private _computeCoverageStats(
    templates: ShiftTemplate[],
    assignments: Array<{ templateId: string; date: string }>,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): { avgPercent: number | null; unfilledShifts: number } {
    if (templates.length === 0 || weekStarts.length === 0) {
      return { avgPercent: null, unfilledShifts: 0 };
    }
    const assignedByTplDate = new Map<string, number>();
    for (const a of assignments) {
      const key = `${a.templateId}|${a.date}`;
      assignedByTplDate.set(key, (assignedByTplDate.get(key) ?? 0) + 1);
    }
    let sumPct = 0;
    let count = 0;
    let unfilled = 0;
    for (const tpl of templates) {
      const required = tpl.requiredEmployees ?? 0;
      if (required === 0) continue;
      const dates = this._templateInstanceDates(tpl, weekStarts, weekStartsOn);
      for (const date of dates) {
        const assigned = assignedByTplDate.get(`${tpl.id}|${date}`) ?? 0;
        const pct = Math.min((assigned / required) * 100, 100);
        sumPct += pct;
        count++;
        // Asientos faltantes en este (template × instancia). Antes
        // contábamos solo cuando assigned=0, lo cual escondía slots
        // parcialmente cubiertos. Ahora el manager ve cuántos
        // empleados le faltan asignar en total.
        unfilled += Math.max(0, required - assigned);
      }
    }
    return {
      avgPercent: count > 0 ? Math.round((sumPct / count) * 10) / 10 : null,
      unfilledShifts: unfilled,
    };
  }

  /** Fechas (ISO) en las que el template se instancia en las weeks pedidas. */
  private _templateInstanceDates(
    tpl: ShiftTemplate,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): string[] {
    const dates: string[] = [];
    for (const ws of weekStarts) {
      const anchor = weekStartOf(new Date(`${ws}T00:00:00.000Z`), weekStartsOn);
      const anchorDow = anchor.getUTCDay();
      const offset = (tpl.dayOfWeek - anchorDow + 7) % 7;
      const d = new Date(anchor);
      d.setUTCDate(d.getUTCDate() + offset);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }
}
