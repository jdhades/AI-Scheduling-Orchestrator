import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type {
  SchedulingStrategy,
  SemanticConstraint,
  StrategyResult,
} from './scheduling-strategy.interface';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';
import {
  buildSkillIndex,
  filterCandidatesForSlot,
  type BusySlot,
} from './shared/strategy-helpers';

/**
 * FairnessOptimizedStrategy — distribuye cargas pesadas (nocturnos,
 * fines de semana, indeseables) de forma equitativa. Opera sobre slots.
 */
export class FairnessOptimizedStrategy implements SchedulingStrategy {
  readonly type = 'fairness' as const;

  generate(
    employees: Employee[],
    slots: VirtualShiftSlot[],
    histories: FairnessHistoryVO[],
    semanticRules?: SemanticConstraint[],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
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

    const skillIndex = buildSkillIndex(employees);
    const busySlots = new Map<string, BusySlot[]>();
    for (const e of employees) busySlots.set(e.id, []);

    const activeConstraints = semanticRules ?? [];
    const assignments: ShiftAssignment[] = [];
    const unfilledSlots: VirtualShiftSlot[] = [];

    // Slots más pesados primero
    const sortedSlots = [...slots].sort(
      (a, b) => b.undesirableWeight - a.undesirableWeight,
    );

    for (const slot of sortedSlots) {
      // No se fuerza cobertura de slots opcionales
      if ((slot.requiredEmployees ?? 0) <= 0) continue;

      const candidates = filterCandidatesForSlot({
        slot,
        employees,
        skillIndex,
        busySlots,
        constraints: activeConstraints,
        workingTimePolicies,
        multiShiftPermits,
      });

      if (candidates.length === 0) {
        unfilledSlots.push(slot);
        continue;
      }

      const ranked = candidates.sort((a, b) => {
        const scoreA =
          (liveHistory.get(a.id)?.computeRawScore() ?? 0) *
          a.getPreferenceMultiplier(slot.startTime);
        const scoreB =
          (liveHistory.get(b.id)?.computeRawScore() ?? 0) *
          b.getPreferenceMultiplier(slot.startTime);
        return scoreA - scoreB;
      });

      const winner = ranked[0];
      busySlots.get(winner.id)!.push({
        slotKey: slot.slotKey,
        startTime: slot.startTime,
        endTime: slot.endTime,
        getDuration: () => slot.getDuration(),
        overlapsWith: (other) => slot.overlapsWith(other),
      });

      const snapshot = this.buildSnapshot(liveHistory);
      assignments.push(
        ShiftAssignment.create({
          id: randomUUID(),
          templateId: slot.templateId,
          date: slot.date,
          employeeId: winner.id,
          companyId: slot.companyId,
          origin: 'membership',
          strategyType: this.type,
          fairnessSnapshot: snapshot,
        }),
      );

      const currentHistory = liveHistory.get(winner.id)!;
      liveHistory.set(
        winner.id,
        currentHistory.addShift(slot.getDuration(), {
          isUndesirable: slot.undesirableWeight >= 0.5,
          isNight: slot.isNightShift(),
          isWeekend: slot.isWeekendShift(),
        }),
      );
    }

    return { assignments, unfilledSlots };
  }

  private buildSnapshot(
    liveHistory: Map<string, FairnessHistoryVO>,
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const [id, h] of liveHistory) snap[id] = h.computeRawScore();
    return snap;
  }
}
