import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FAIRNESS_HISTORY_REPOSITORY,
  type IFairnessHistoryRepository,
} from '../repositories/fairness-history.repository';
import { CoverageService } from './coverage.service';
import type { WeekStartsOn } from '../shared/week';

export interface ApprovalBreakdown {
  pending: number;
  approved: number;
  rejected: number;
}

export interface OperationalKpis {
  weekStarts: string[];
  coverage: {
    /** Promedio de % cobertura sobre todas las celdas con required>0. Null si no hay celdas requeridas. */
    avgPercent: number | null;
    /** Celdas con required>0 y assigned=0 sumadas en todas las semanas. */
    unfilledShifts: number;
    /** Total de celdas con required>0 en el período (para mostrar fracción). */
    totalRequiredCells: number;
  };
  approvals: {
    swap: ApprovalBreakdown;
    dayOff: ApprovalBreakdown;
    /** approved / (approved + rejected) global. Null si denom=0. */
    approvalRate: number | null;
    /** Absence reports en el período — son hechos, no approvals, pero útiles
     *  para tener un único KPI de "actividad del staff" en el manager view. */
    absenceReportsCount: number;
  };
  fairness: {
    /** Promedio del CV (coeficiente de variación de horas) por las semanas con data. */
    avgCv: number | null;
    weeksWithData: number;
  };
  generations: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
}

/**
 * OperationalKpisService — agrega métricas tenant-wide para el dashboard
 * del manager/owner. Multi-week (acepta el array de weekStarts que el
 * filtro de período ya construye).
 *
 * Sin tablas nuevas — todo se calcula reusando CoverageService +
 * queries a las tablas existentes (shift_swap_requests, day_off_requests,
 * absence_reports, fairness_history, schedule_generation_runs).
 */
@Injectable()
export class OperationalKpisService {
  constructor(
    private readonly coverageService: CoverageService,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepo: IFairnessHistoryRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  async getKpis(
    companyId: string,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): Promise<OperationalKpis> {
    const [coverage, approvals, fairness, generations] = await Promise.all([
      this._computeCoverage(companyId, weekStarts, weekStartsOn),
      this._computeApprovals(companyId, weekStarts, weekStartsOn),
      this._computeFairness(companyId, weekStarts),
      this._computeGenerations(companyId, weekStarts),
    ]);
    return { weekStarts, coverage, approvals, fairness, generations };
  }

  private async _computeCoverage(
    companyId: string,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): Promise<OperationalKpis['coverage']> {
    const reports = await Promise.all(
      weekStarts.map((ws) =>
        this.coverageService.getWeekCoverage(companyId, ws, weekStartsOn),
      ),
    );
    let totalRequiredCells = 0;
    let totalPctSum = 0;
    let unfilledShifts = 0;
    for (const report of reports) {
      for (const day of report.days) {
        for (const cell of day.cells) {
          if (cell.required <= 0) continue;
          totalRequiredCells++;
          const pct = (cell.assigned / cell.required) * 100;
          totalPctSum += Math.min(pct, 100); // cap a 100 — overstaffing no cuenta como "más cubierto"
          // Sumamos los asientos faltantes (required - assigned). Antes
          // contábamos solo celdas con assigned=0, que confundía al
          // manager: cubrir 1 de 2 huecos no reducía el número aunque
          // sí mejorara la cobertura. La métrica nueva responde a
          // "¿cuántos asientos me falta cubrir?".
          unfilledShifts += Math.max(0, cell.required - cell.assigned);
        }
      }
    }
    const avgPercent =
      totalRequiredCells > 0 ? totalPctSum / totalRequiredCells : null;
    return {
      avgPercent: avgPercent !== null ? Math.round(avgPercent * 10) / 10 : null,
      unfilledShifts,
      totalRequiredCells,
    };
  }

  private async _computeApprovals(
    companyId: string,
    weekStarts: string[],
    weekStartsOn: WeekStartsOn,
  ): Promise<OperationalKpis['approvals']> {
    if (weekStarts.length === 0) {
      const empty: ApprovalBreakdown = { pending: 0, approved: 0, rejected: 0 };
      return { swap: empty, dayOff: empty, approvalRate: null, absenceReportsCount: 0 };
    }
    const { from, to } = this._dateRange(weekStarts);

    const [swap, dayOff, absenceReportsCount] = await Promise.all([
      this._countByStatus(
        'shift_swap_requests',
        companyId,
        from,
        to,
        'accepted',
      ),
      this._countByStatus('day_off_requests', companyId, from, to, 'approved'),
      this._countAbsenceReports(companyId, from, to),
    ]);
    void weekStartsOn;

    const totalApproved = swap.approved + dayOff.approved;
    const totalRejected = swap.rejected + dayOff.rejected;
    const denom = totalApproved + totalRejected;
    const approvalRate =
      denom > 0 ? Math.round((totalApproved / denom) * 1000) / 10 : null;

    return { swap, dayOff, approvalRate, absenceReportsCount };
  }

  /** AbsenceReport no tiene status — solo contamos las filas en el rango. */
  private async _countAbsenceReports(
    companyId: string,
    fromIso: string,
    toIso: string,
  ): Promise<number> {
    const { count, error } = await this.supabase
      .from('absence_reports')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('start_date', fromIso)
      .lte('start_date', toIso);
    if (error) {
      throw new Error(
        `OperationalKpisService._countAbsenceReports failed: ${error.message}`,
      );
    }
    return count ?? 0;
  }

  /** Cuenta filas por status (pending / approved-equivalent / rejected). */
  private async _countByStatus(
    table: string,
    companyId: string,
    fromIso: string,
    toIso: string,
    approvedKey: 'accepted' | 'approved',
  ): Promise<ApprovalBreakdown> {
    const { data, error } = await this.supabase
      .from(table)
      .select('status')
      .eq('company_id', companyId)
      .gte('created_at', `${fromIso}T00:00:00.000Z`)
      .lte('created_at', `${toIso}T23:59:59.999Z`);
    if (error) {
      throw new Error(
        `OperationalKpisService._countByStatus(${table}) failed: ${error.message}`,
      );
    }
    const breakdown: ApprovalBreakdown = { pending: 0, approved: 0, rejected: 0 };
    for (const row of data ?? []) {
      const status = row.status as string;
      if (status === 'pending') breakdown.pending++;
      else if (status === approvedKey) breakdown.approved++;
      else if (status === 'rejected') breakdown.rejected++;
      // Otros estados (cancelled, expired) no se cuentan.
    }
    return breakdown;
  }

  private async _computeFairness(
    companyId: string,
    weekStarts: string[],
  ): Promise<OperationalKpis['fairness']> {
    const reports = await Promise.all(
      weekStarts.map((ws) =>
        this.fairnessRepo.findByWeek(companyId, new Date(`${ws}T00:00:00.000Z`)),
      ),
    );
    const cvsByWeek: number[] = [];
    for (const rows of reports) {
      if (rows.length === 0) continue;
      const hours = rows.map((r) => r.hoursWorked).filter((h) => h > 0);
      if (hours.length === 0) continue;
      const mean = hours.reduce((acc, h) => acc + h, 0) / hours.length;
      if (mean === 0) continue;
      const variance =
        hours.reduce((acc, h) => acc + (h - mean) ** 2, 0) / hours.length;
      const stdDev = Math.sqrt(variance);
      cvsByWeek.push((stdDev / mean) * 100);
    }
    const avgCv =
      cvsByWeek.length > 0
        ? Math.round(
            (cvsByWeek.reduce((a, b) => a + b, 0) / cvsByWeek.length) * 10,
          ) / 10
        : null;
    return { avgCv, weeksWithData: cvsByWeek.length };
  }

  private async _computeGenerations(
    companyId: string,
    weekStarts: string[],
  ): Promise<OperationalKpis['generations']> {
    if (weekStarts.length === 0) {
      return { total: 0, succeeded: 0, failed: 0, cancelled: 0 };
    }
    const { data, error } = await this.supabase
      .from('schedule_generation_runs')
      .select('status')
      .eq('company_id', companyId)
      .in('week_start', weekStarts);
    if (error) {
      throw new Error(
        `OperationalKpisService._computeGenerations failed: ${error.message}`,
      );
    }
    const breakdown = { total: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of data ?? []) {
      breakdown.total++;
      if (row.status === 'completed') breakdown.succeeded++;
      else if (row.status === 'failed') breakdown.failed++;
      else if (row.status === 'cancelled') breakdown.cancelled++;
    }
    return breakdown;
  }

  /** Min/max del array de weekStarts. La ventana cubre 7 días por semana. */
  private _dateRange(weekStarts: string[]): { from: string; to: string } {
    const sorted = [...weekStarts].sort();
    const from = sorted[0];
    const lastStart = sorted[sorted.length - 1];
    const lastDate = new Date(`${lastStart}T00:00:00.000Z`);
    lastDate.setUTCDate(lastDate.getUTCDate() + 6);
    const to = lastDate.toISOString().slice(0, 10);
    return { from, to };
  }
}
