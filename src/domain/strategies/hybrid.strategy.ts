import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type {
  SchedulingStrategy,
  SemanticConstraint,
  StrategyResult,
} from './scheduling-strategy.interface';

export interface HybridWeights {
  /** Peso del factor de costo en la fórmula (default: 0.3) */
  costWeight: number;
  /** Peso del factor de fairness en la fórmula (default: 0.5) */
  fairnessWeight: number;
  /** Peso del factor de demanda en la fórmula (default: 0.2) */
  demandWeight: number;
}

const DEFAULT_WEIGHTS: HybridWeights = {
  costWeight: 0.3,
  fairnessWeight: 0.5,
  demandWeight: 0.2,
};

/**
 * HybridStrategy — Strategy Pattern (DEFAULT para producción)
 *
 * Score combinado configurable por empresa:
 *   TotalScore = (CostWeight × costFactor) + (FairnessWeight × fairnessFactor) + (DemandWeight × demandFactor)
 *
 * costFactor:     normalizado [0..1] — mayor costo/hora = mayor score = menos preferido
 * fairnessFactor: normalizado [0..1] — mayor acumulación = mayor score = menos preferido
 * demandFactor:   normalizado [0..1] — mayor demanda del turno = se garantiza cobertura
 *
 * El candidato con MENOR TotalScore se asigna primero.
 */
export class HybridStrategy implements SchedulingStrategy {
  readonly type = 'hybrid' as const;

  private readonly weights: HybridWeights;

  constructor(weights?: Partial<HybridWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.validateWeights();
  }

  private validateWeights(): void {
    const sum =
      this.weights.costWeight +
      this.weights.fairnessWeight +
      this.weights.demandWeight;
    if (Math.abs(sum - 1.0) > 0.001) {
      throw new Error(
        `HybridStrategy weights must sum to 1.0, got ${sum.toFixed(3)}`,
      );
    }
  }

  generate(
    employees: Employee[],
    shifts: Shift[],
    histories: FairnessHistoryVO[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _semanticRules?: SemanticConstraint[],
  ): StrategyResult {
    const liveHistory = new Map<string, FairnessHistoryVO>(
      employees.map((e) => {
        const existing = histories.find((h) => h.employeeId === e.id);
        return [
          e.id,
          existing ?? FairnessHistoryVO.empty(e.id, e.companyId, new Date()),
        ];
      }),
    );

    const skillIndex = this.buildSkillIndex(employees);
    const busySlots = new Map<string, { id: string; startTime: Date; endTime: Date; getDuration: () => number; overlapsWith: (other: Shift) => boolean }[]>();
    for (const e of employees) busySlots.set(e.id, []);

    // Max score para normalización
    const maxRawFairness = Math.max(
      ...histories.map((h) => h.computeRawScore()),
      1, // evitar div/0
    );

    const assignments: ShiftAssignment[] = [];
    const unfilledShifts: Shift[] = [];

    // Turnos más críticos (demanda) primero
    const sortedShifts = [...shifts].sort(
      (a, b) => b.demandScore.value - a.demandScore.value,
    );

    for (const shift of sortedShifts) {
      const candidates = this.getCandidates(
        shift,
        employees,
        skillIndex,
        busySlots,
      );

      if (candidates.length === 0) {
        unfilledShifts.push(shift);
        continue;
      }

      const ranked = candidates.sort((a, b) => {
        const scoreA = this.totalScore(
          a,
          shift,
          liveHistory.get(a.id),
          maxRawFairness,
        );
        const scoreB = this.totalScore(
          b,
          shift,
          liveHistory.get(b.id),
          maxRawFairness,
        );
        return scoreA - scoreB; // menor = más preferido
      });

      const winner = ranked[0];
      busySlots.get(winner.id)!.push({
        id: shift.id,
        startTime: shift.startTime,
        endTime: shift.endTime,
        getDuration: () => shift.getDuration(),
        overlapsWith: (other: Shift) => shift.overlapsWith(other),
      });

      const snapshot = this.buildSnapshot(liveHistory);
      assignments.push(
        ShiftAssignment.create({
          id: randomUUID(),
          shiftId: shift.id,
          employeeId: winner.id,
          companyId: shift.companyId,
          strategyType: this.type,
          fairnessSnapshot: snapshot,
        }),
      );

      const currentHistory = liveHistory.get(winner.id)!;
      liveHistory.set(
        winner.id,
        currentHistory.addShift(shift.getDuration(), {
          isUndesirable: shift.undesirableWeight.isHeavy(),
          isNight: shift.isNightShift(),
          isWeekend: shift.isWeekendShift(),
        }),
      );
    }

    return { assignments, unfilledShifts };
  }

  /**
   * TotalScore = (CostWeight × costFactor) + (FairnessWeight × fairnessFactor) + (DemandWeight × demandFactor)
   * Menor es mejor (candidato más idóneo).
   */
  private totalScore(
    employee: Employee,
    shift: Shift,
    history: FairnessHistoryVO | undefined,
    maxRawFairness: number,
  ): number {
    const costFactor = this.normalizeCost(employee.experienceMonths);
    const fairnessFactor = Math.min(
      (history?.computeRawScore() ?? 0) / maxRawFairness,
      1,
    );
    const demandFactor = shift.demandScore.normalized();

    // Soft Constraint: multiply by preference to nudge preferred employees lower in score
    const preferenceMultiplier = employee.getPreferenceMultiplier(
      shift.startTime,
    );

    return (
      (this.weights.costWeight * costFactor +
        this.weights.fairnessWeight * fairnessFactor +
        this.weights.demandWeight * demandFactor) *
      preferenceMultiplier
    );
  }

  private normalizeCost(experienceMonths: number): number {
    if (experienceMonths < 6) return 1 / 3; // junior
    if (experienceMonths < 24) return 2 / 3; // intermediate
    return 1; // senior
  }

  private buildSkillIndex(employees: Employee[]): Map<string, Employee[]> {
    const index = new Map<string, Employee[]>();
    for (const emp of employees) {
      for (const skill of emp.getSkills()) {
        if (!index.has(skill.id)) index.set(skill.id, []);
        index.get(skill.id)!.push(emp);
      }
    }
    return index;
  }

  private getCandidates(
    shift: Shift,
    employees: Employee[],
    skillIndex: Map<string, Employee[]>,
    busySlots: Map<string, { id: string; startTime: Date; endTime: Date; getDuration: () => number; overlapsWith: (other: Shift) => boolean }[]>,
  ): Employee[] {
    const pool = shift.requiredSkillId
      ? (skillIndex.get(shift.requiredSkillId) ?? [])
      : employees;

    const uniquePool = Array.from(new Set(pool));

    return uniquePool.filter((emp) => {
      const busy = busySlots.get(emp.id) ?? [];
      if (busy.some((s) => s.overlapsWith(shift))) return false;

      const MAX_HOURS_PER_DAY = 8;
      const MAX_HOURS_PER_WEEK = 40;
      const MIN_GAP_HOURS = 11;
      const proposedDuration = shift.getDuration();

      // Hard: weekly hours cap
      const weeklyHours = busy.reduce((acc, s) => acc + s.getDuration(), 0);
      if (weeklyHours + proposedDuration > MAX_HOURS_PER_WEEK) return false;

      // Hard: daily hours cap
      const proposedStartStr = shift.startTime.toISOString().split('T')[0];
      const dailyHours = busy
        .filter(
          (s) => s.startTime.toISOString().split('T')[0] === proposedStartStr,
        )
        .reduce((acc, s) => acc + s.getDuration(), 0);
      if (dailyHours + proposedDuration > MAX_HOURS_PER_DAY) return false;

      // Hard: structural availability
      if (!emp.isAvailable(shift.startTime, shift.endTime)) return false;

      // Hard: minimum gap between shifts (anti-clopening)
      const minGapMs = MIN_GAP_HOURS * 60 * 60 * 1000;
      const gapViolation = busy.some((prev) => {
        const gapAfter = shift.startTime.getTime() - prev.endTime.getTime();
        const gapBefore = prev.startTime.getTime() - shift.endTime.getTime();
        return (
          (gapAfter >= 0 && gapAfter < minGapMs) ||
          (gapBefore >= 0 && gapBefore < minGapMs)
        );
      });
      if (gapViolation) return false;

      return true;
    });
  }

  private buildSnapshot(
    liveHistory: Map<string, FairnessHistoryVO>,
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const [id, h] of liveHistory) snap[id] = h.computeRawScore();
    return snap;
  }
}
