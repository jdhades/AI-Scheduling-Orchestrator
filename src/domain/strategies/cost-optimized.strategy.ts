import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
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
 * CostOptimizedStrategy — minimiza costo de nómina.
 * Opera sobre VirtualShiftSlot. Junior < Intermediate < Senior.
 */
export class CostOptimizedStrategy implements SchedulingStrategy {
  readonly type = 'cost' as const;

  // TODO(config-per-tenant): EXPERIENCE_COST hardcodeado (junior=1, intermediate=2, senior=3).
  private static readonly EXPERIENCE_COST: Record<string, number> = {
    junior: 1,
    intermediate: 2,
    senior: 3,
  };

  // TODO(config-per-tenant): umbral 600/1000 y factor 1.2 hardcodeados.
  private static readonly FAIRNESS_PENALTY_THRESHOLD = 600;
  private static readonly FAIRNESS_PENALTY_FACTOR = 1.2;

  generate(
    employees: Employee[],
    slots: VirtualShiftSlot[],
    histories: FairnessHistoryVO[],
    semanticRules?: SemanticConstraint[],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
  ): StrategyResult {
    const historyIndex = new Map<string, FairnessHistoryVO>(
      histories.map((h) => [h.employeeId, h]),
    );
    const snapshot = this.buildSnapshot(histories);

    const busySlots = new Map<string, BusySlot[]>();
    for (const e of employees) busySlots.set(e.id, []);

    const skillIndex = buildSkillIndex(employees);
    const activeConstraints = semanticRules ?? [];

    const assignments: ShiftAssignment[] = [];
    const unfilledSlots: VirtualShiftSlot[] = [];

    // Slots más críticos primero
    const sortedSlots = [...slots].sort(
      (a, b) => b.demandScore - a.demandScore,
    );

    for (const slot of sortedSlots) {
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
        const costA = this.effectiveCost(a, slot, historyIndex.get(a.id), activeConstraints);
        const costB = this.effectiveCost(b, slot, historyIndex.get(b.id), activeConstraints);
        return costA - costB;
      });

      const winner = ranked[0];
      busySlots.get(winner.id)!.push({
        slotKey: slot.slotKey,
        startTime: slot.startTime,
        endTime: slot.endTime,
        getDuration: () => slot.getDuration(),
        overlapsWith: (other) => slot.overlapsWith(other),
      });

      assignments.push(
        ShiftAssignment.create({
          id: randomUUID(),
          templateId: slot.templateId,
          date: slot.date,
          employeeId: winner.id,
          companyId: slot.companyId,
          origin: 'membership',
          strategyType: this.type,
          fairnessSnapshot: { ...snapshot },
        }),
      );
    }

    return { assignments, unfilledSlots };
  }

  private effectiveCost(
    employee: Employee,
    slot: VirtualShiftSlot,
    history?: FairnessHistoryVO,
    constraints: SemanticConstraint[] = [],
  ): number {
    // TODO(config-per-tenant): umbrales 24/6 meses duplicados con HybridStrategy.
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

    const preferenceMultiplier = employee.getPreferenceMultiplier(
      slot.startTime,
    );

    const hasSoftBlock = constraints.some(
      (c) =>
        c.weight === 1 &&
        c.employeeId === employee.id &&
        (!c.shiftId || c.shiftId === slot.slotKey),
    );
    // TODO(config-per-tenant): factor 1.5 hardcodeado y duplicado con HybridStrategy.
    const semanticPenalty = hasSoftBlock ? 1.5 : 1;

    return baseCost * fairnessMultiplier * preferenceMultiplier * semanticPenalty;
  }

  private buildSnapshot(
    histories: FairnessHistoryVO[],
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const h of histories) snap[h.employeeId] = h.computeRawScore();
    return snap;
  }
}
