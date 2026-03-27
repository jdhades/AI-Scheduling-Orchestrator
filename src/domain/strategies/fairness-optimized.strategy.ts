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

/**
 * FairnessOptimizedStrategy — Strategy Pattern
 *
 * Objetivo: distribuir cargas pesadas (nocturnos, fines de semana, indeseables)
 * de forma equitativa entre todos los empleados.
 *
 * Algoritmo:
 *   1. Para cada turno (ordenados por undesirableWeight DESC — más pesados primero)
 *   2. Filtrar candidatos con skill válido y sin solapamiento
 *   3. Ordenar candidatos por menor fairness score acumulado (más descansados primero)
 *   4. Asignar al primero de la lista
 *   5. Actualizar el score en memoria para la siguiente iteración
 *      → garantiza que si A recibe un turno duro, B será considerado antes en el siguiente
 *
 * Complejidad: O(n log n) — el sort de candidatos es dominante.
 */
export class FairnessOptimizedStrategy implements SchedulingStrategy {
  readonly type = 'fairness' as const;

  generate(
    employees: Employee[],
    shifts: Shift[],
    histories: FairnessHistoryVO[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _semanticRules?: SemanticConstraint[],
  ): StrategyResult {
    // Historial mutable en memoria — se actualiza en c/asignación
    const liveHistory = new Map<string, FairnessHistoryVO>(
      employees.map((e) => {
        const existing = histories.find((h) => h.employeeId === e.id);
        return [
          e.id,
          existing ?? FairnessHistoryVO.empty(e.id, e.companyId, new Date()),
        ];
      }),
    );

    // Pre-indexar employees por skill
    const skillIndex = this.buildSkillIndex(employees);
    const busySlots = new Map<string, Shift[]>();
    for (const e of employees) busySlots.set(e.id, []);

    const assignments: ShiftAssignment[] = [];
    const unfilledShifts: Shift[] = [];

    // Turnos más pesados primero — maximiza distribución equitativa de carga
    const sortedShifts = [...shifts].sort(
      (a, b) => b.undesirableWeight.value - a.undesirableWeight.value,
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

      // Ordenar por menor raw score (más descansados primero), con ajuste por preferencias (soft)
      const ranked = candidates.sort((a, b) => {
        const scoreA =
          (liveHistory.get(a.id)?.computeRawScore() ?? 0) *
          a.getPreferenceMultiplier(shift.startTime);
        const scoreB =
          (liveHistory.get(b.id)?.computeRawScore() ?? 0) *
          b.getPreferenceMultiplier(shift.startTime);
        return scoreA - scoreB;
      });

      const winner = ranked[0];
      busySlots.get(winner.id)!.push(shift);

      // Snapshot del estado ANTES de asignar
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

      // Actualizar historial en memoria para la siguiente iteración
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
    liveHistory: Map<string, FairnessHistoryVO>,
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const [id, h] of liveHistory) snap[id] = h.computeRawScore();
    return snap;
  }
}
