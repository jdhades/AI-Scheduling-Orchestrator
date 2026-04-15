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

    const pickFor = (slot: VirtualShiftSlot): Employee | null => {
      const candidates = filterCandidatesForSlot({
        slot,
        employees,
        skillIndex,
        busySlots,
        constraints: activeConstraints,
        workingTimePolicies,
        multiShiftPermits,
      });
      if (candidates.length === 0) return null;
      const ranked = candidates.sort((a, b) => {
        const scoreA =
          (liveHistory.get(a.id)?.computeRawScore() ?? 0) *
          a.getPreferenceMultiplier(slot.startTime);
        const scoreB =
          (liveHistory.get(b.id)?.computeRawScore() ?? 0) *
          b.getPreferenceMultiplier(slot.startTime);
        return scoreA - scoreB;
      });
      return ranked[0];
    };

    const assignWinner = (slot: VirtualShiftSlot, winner: Employee): void => {
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
          actualStartTime: slot.startTime,
          actualEndTime: slot.endTime,
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
    };

    // Phase A: slots con target explícito
    for (const slot of sortedSlots) {
      const targetRaw = slot.requiredEmployees;
      if (targetRaw === 0) continue;
      if (targetRaw === null || targetRaw === undefined) continue;
      const target = targetRaw;

      let filled = 0;
      while (filled < target) {
        const winner = pickFor(slot);
        if (!winner) {
          if (filled === 0) unfilledSlots.push(slot);
          break;
        }
        assignWinner(slot, winner);
        filled++;
      }
    }

    // Phase B: round-robin sobre slots elásticos
    const elasticSlots = slots.filter(
      (s) => s.requiredEmployees === null || s.requiredEmployees === undefined,
    );
    if (elasticSlots.length > 0) {
      const fillBySlot = new Map<string, number>();
      for (const a of assignments) {
        fillBySlot.set(a.slotKey, (fillBySlot.get(a.slotKey) ?? 0) + 1);
      }
      const elasticByDate = new Map<string, VirtualShiftSlot[]>();
      for (const s of elasticSlots) {
        if (!elasticByDate.has(s.date)) elasticByDate.set(s.date, []);
        elasticByDate.get(s.date)!.push(s);
      }

      for (const [date, dateSlots] of elasticByDate) {
        const candidatesToday = employees.filter((emp) => {
          const busy = busySlots.get(emp.id) ?? [];
          const worksToday = busy.some((b) => b.startTime.toISOString().split('T')[0] === date);
          if (!worksToday) return true;
          return multiShiftPermits?.has(`${emp.id}|${date}`) ?? false;
        });

        for (const emp of candidatesToday) {
          const ranked = [...dateSlots]
            .map((s) => ({ slot: s, fill: fillBySlot.get(s.slotKey) ?? 0 }))
            .sort((a, b) => a.fill - b.fill);
          for (const { slot } of ranked) {
            const eligible = filterCandidatesForSlot({
              slot,
              employees: [emp],
              skillIndex,
              busySlots,
              constraints: activeConstraints,
              workingTimePolicies,
              multiShiftPermits,
            });
            if (eligible.length === 0) continue;
            assignWinner(slot, emp);
            fillBySlot.set(slot.slotKey, (fillBySlot.get(slot.slotKey) ?? 0) + 1);
            break;
          }
        }
      }
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
