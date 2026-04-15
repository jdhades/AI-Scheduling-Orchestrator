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

    // Phase A: slots con target explícito (N > 0) se cubren hasta N.
    for (const slot of sortedSlots) {
      const targetRaw = slot.requiredEmployees;
      if (targetRaw === 0) continue;
      if (targetRaw === null || targetRaw === undefined) continue;
      const target = targetRaw;

      let filled = 0;
      while (filled < target) {
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
          if (filled === 0) unfilledSlots.push(slot);
          break;
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
        filled++;
      }
    }

    // Phase B: round-robin sobre slots elásticos (requiredEmployees === null)
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

            busySlots.get(emp.id)!.push({
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
                employeeId: emp.id,
                companyId: slot.companyId,
                origin: 'membership',
                strategyType: this.type,
                fairnessSnapshot: { ...snapshot },
              }),
            );
            fillBySlot.set(slot.slotKey, (fillBySlot.get(slot.slotKey) ?? 0) + 1);
            break;
          }
        }
      }
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
