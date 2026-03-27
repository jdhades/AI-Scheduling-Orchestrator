import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type {
  SchedulingStrategy,
  SemanticConstraint,
  StrategyResult,
} from './scheduling-strategy.interface';

/**
 * CostOptimizedStrategy — Strategy Pattern
 *
 * Objetivo: minimizar el costo de la nómina semanal.
 *
 * Algoritmo (Greedy por costo):
 *   1. Para cada turno, filtrar candidatos con el skill requerido
 *   2. Ordenar por nivel de experiencia ASC (Junior < Intermediate < Senior)
 *      → usar el recurso más económico suficiente para el turno
 *   3. Aplicar penalización del 20% si el fairness score supera threshold
 *   4. Asignar al candidato de menor costo efectivo
 *   5. Marcar empleado como ocupado en ese slot para evitar solapamientos
 *
 * Complejidad: O(n log n) por turno — pre-indexación de skills con Map.
 */
export class CostOptimizedStrategy implements SchedulingStrategy {
  readonly type = 'cost' as const;

  private static readonly EXPERIENCE_COST: Record<string, number> = {
    junior: 1,
    intermediate: 2,
    senior: 3,
  };

  private static readonly FAIRNESS_PENALTY_THRESHOLD = 600; // de 1000
  private static readonly FAIRNESS_PENALTY_FACTOR = 1.2; // +20%

  generate(
    employees: Employee[],
    shifts: Shift[],
    histories: FairnessHistoryVO[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _semanticRules?: SemanticConstraint[],
  ): StrategyResult {
    // Índice de historial por employeeId — O(1) lookup
    const historyIndex = new Map<string, FairnessHistoryVO>(
      histories.map((h) => [h.employeeId, h]),
    );

    // Snapshot de scores actuales para embeber en c/asignación
    const snapshot = this.buildSnapshot(histories);

    // Rastrear ocupación: employeeId → slots asignados
    const busySlots = new Map<string, Shift[]>();
    for (const e of employees) busySlots.set(e.id, []);

    // Pre-indexar employees por skill: skillId → Employee[]
    const skillIndex = this.buildSkillIndex(employees);

    const assignments: ShiftAssignment[] = [];
    const unfilledShifts: Shift[] = [];

    // Ordenar turnos por demandScore DESC (cubrir los más críticos primero)
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

      // Ordenar por costo efectivo (base + penalización por fairness)
      const ranked = candidates.sort((a, b) => {
        const costA = this.effectiveCost(a, shift, historyIndex.get(a.id));
        const costB = this.effectiveCost(b, shift, historyIndex.get(b.id));
        return costA - costB;
      });

      const winner = ranked[0];
      busySlots.get(winner.id)!.push(shift);

      assignments.push(
        ShiftAssignment.create({
          id: randomUUID(),
          shiftId: shift.id,
          employeeId: winner.id,
          companyId: shift.companyId,
          strategyType: this.type,
          fairnessSnapshot: { ...snapshot },
        }),
      );
    }

    return { assignments, unfilledShifts };
  }

  private effectiveCost(
    employee: Employee,
    shift: Shift,
    history?: FairnessHistoryVO,
  ): number {
    const baseCost =
      CostOptimizedStrategy.EXPERIENCE_COST[
        employee.experienceMonths >= 24
          ? 'senior'
          : employee.experienceMonths >= 6
            ? 'intermediate'
            : 'junior'
      ] ?? 1;

    const rawScore = history?.computeRawScore() ?? 0;
    const fairnessMultiplier =
      rawScore > CostOptimizedStrategy.FAIRNESS_PENALTY_THRESHOLD
        ? CostOptimizedStrategy.FAIRNESS_PENALTY_FACTOR
        : 1;

    // Soft Constraint: apply preference bias
    const preferenceMultiplier = employee.getPreferenceMultiplier(
      shift.startTime,
    );

    return baseCost * fairnessMultiplier * preferenceMultiplier;
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
    busySlots: Map<string, Shift[]>,
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
    histories: FairnessHistoryVO[],
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const h of histories) snap[h.employeeId] = h.computeRawScore();
    return snap;
  }
}
