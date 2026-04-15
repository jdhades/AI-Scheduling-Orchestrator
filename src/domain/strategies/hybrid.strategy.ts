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

export interface HybridWeights {
  costWeight: number;
  fairnessWeight: number;
  demandWeight: number;
}

// TODO(config-per-tenant): pesos hardcodeados — filosofía de optimización.
const DEFAULT_WEIGHTS: HybridWeights = {
  costWeight: 0.3,
  fairnessWeight: 0.5,
  demandWeight: 0.2,
};

/**
 * HybridStrategy — Strategy Pattern (DEFAULT).
 * Opera sobre VirtualShiftSlot (template × date). El candidato con menor
 * TotalScore = w_c·cost + w_f·fairness + w_d·demand se asigna primero.
 */
export class HybridStrategy implements SchedulingStrategy {
  readonly type = 'hybrid' as const;
  private readonly weights: HybridWeights;

  constructor(weights?: Partial<HybridWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    const sum = this.weights.costWeight + this.weights.fairnessWeight + this.weights.demandWeight;
    if (Math.abs(sum - 1.0) > 0.001) {
      throw new Error(`HybridStrategy weights must sum to 1.0, got ${sum.toFixed(3)}`);
    }
  }

  generate(
    employees: Employee[],
    slots: VirtualShiftSlot[],
    histories: FairnessHistoryVO[],
    semanticRules?: SemanticConstraint[],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
  ): StrategyResult {
    const activeConstraints = semanticRules ?? [];

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

    const maxRawFairness = Math.max(
      ...histories.map((h) => h.computeRawScore()),
      1,
    );

    const assignments: ShiftAssignment[] = [];
    const unfilledSlots: VirtualShiftSlot[] = [];

    // Slots más críticos (demanda) primero
    const sortedSlots = [...slots].sort(
      (a, b) => b.demandScore - a.demandScore,
    );

    for (const slot of sortedSlots) {
      // Semántica nueva de `requiredEmployees`:
      //   0           → slot excluido (ej. feriado), no se asigna nadie.
      //   N > 0       → target blando: Phase A intenta poner hasta N.
      //   null/undef  → elástico: Phase A no lo toca; Phase B distribuye leftovers.
      const targetRaw = slot.requiredEmployees;
      if (targetRaw === 0) continue;
      if (targetRaw === null || targetRaw === undefined) continue; // elástico → Phase B abajo
      const targetCapacity = targetRaw;

      let assignedToThisSlot = 0;
      while (assignedToThisSlot < targetCapacity) {
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
          if (assignedToThisSlot === 0) unfilledSlots.push(slot);
          break;
        }

        const ranked = candidates.sort((a, b) => {
          const scoreA = this.totalScore(a, slot, liveHistory.get(a.id), maxRawFairness, activeConstraints);
          const scoreB = this.totalScore(b, slot, liveHistory.get(b.id), maxRawFairness, activeConstraints);
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
        assignedToThisSlot++;
      }
    }

    // ── Phase B: round-robin sobre slots elásticos (requiredEmployees === null)
    // Para cada día, cualquier empleado que todavía no tenga un turno hoy se
    // empuja al slot elástico con menor fill actual. No hay "target" — reciben
    // todo el sobrante. Respeta siempre one-shift-per-day (salvo permit).
    const elasticSlots = slots.filter((s) => s.requiredEmployees === null || s.requiredEmployees === undefined);
    if (elasticSlots.length > 0) {
      // Fill count por slotKey (inicializado con lo que ya se asignó en Phase A)
      const fillBySlot = new Map<string, number>();
      for (const a of assignments) {
        fillBySlot.set(a.slotKey, (fillBySlot.get(a.slotKey) ?? 0) + 1);
      }

      // Agrupar slots elásticos por fecha
      const elasticByDate = new Map<string, VirtualShiftSlot[]>();
      for (const s of elasticSlots) {
        if (!elasticByDate.has(s.date)) elasticByDate.set(s.date, []);
        elasticByDate.get(s.date)!.push(s);
      }

      for (const [date, dateSlots] of elasticByDate) {
        // Empleados que todavía no están asignados hoy (o que tienen permit)
        const candidatesToday = employees.filter((emp) => {
          const busy = busySlots.get(emp.id) ?? [];
          const worksToday = busy.some((b) => b.startTime.toISOString().split('T')[0] === date);
          if (!worksToday) return true;
          return multiShiftPermits?.has(`${emp.id}|${date}`) ?? false;
        });

        for (const emp of candidatesToday) {
          // Entre slots elásticos del día, elegir el de menor fill
          const ranked = [...dateSlots]
            .map((s) => ({ slot: s, fill: fillBySlot.get(s.slotKey) ?? 0 }))
            .sort((a, b) => a.fill - b.fill);

          let placed = false;
          for (const { slot } of ranked) {
            // Verificar elegibilidad del empleado para este slot
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

            const snapshot = this.buildSnapshot(liveHistory);
            assignments.push(
              ShiftAssignment.create({
                id: randomUUID(),
                templateId: slot.templateId,
                date: slot.date,
                employeeId: emp.id,
                companyId: slot.companyId,
                origin: 'membership',
                strategyType: this.type,
                fairnessSnapshot: snapshot,
          actualStartTime: slot.startTime,
          actualEndTime: slot.endTime,
              }),
            );
            fillBySlot.set(slot.slotKey, (fillBySlot.get(slot.slotKey) ?? 0) + 1);

            const currentHistory = liveHistory.get(emp.id)!;
            liveHistory.set(
              emp.id,
              currentHistory.addShift(slot.getDuration(), {
                isUndesirable: slot.undesirableWeight >= 0.5,
                isNight: slot.isNightShift(),
                isWeekend: slot.isWeekendShift(),
              }),
            );
            placed = true;
            break;
          }
          // Si no se pudo colocar (ningún slot acepta al empleado), sigue.
          void placed;
        }
      }
    }

    return { assignments, unfilledSlots };
  }

  private totalScore(
    employee: Employee,
    slot: VirtualShiftSlot,
    history: FairnessHistoryVO | undefined,
    maxRawFairness: number,
    constraints: SemanticConstraint[] = [],
  ): number {
    const costFactor = this.normalizeCost(employee.experienceMonths);
    const fairnessFactor = Math.min(
      (history?.computeRawScore() ?? 0) / maxRawFairness,
      1,
    );
    const demandFactor = Math.min(Math.max(slot.demandScore / 5, 0), 1); // normalizado 0..1 sobre 5
    const preferenceMultiplier = employee.getPreferenceMultiplier(slot.startTime);

    const hasSoftBlock = constraints.some(
      (c) =>
        c.weight === 1 &&
        c.employeeId === employee.id &&
        (!c.shiftId || c.shiftId === slot.slotKey),
    );
    // TODO(config-per-tenant): factor 1.5 hardcodeado.
    const semanticPenalty = hasSoftBlock ? 1.5 : 1;

    return (
      (this.weights.costWeight * costFactor +
        this.weights.fairnessWeight * fairnessFactor +
        this.weights.demandWeight * demandFactor) *
      preferenceMultiplier *
      semanticPenalty
    );
  }

  // TODO(config-per-tenant): umbrales 6/24 meses hardcodeados.
  private normalizeCost(experienceMonths: number): number {
    if (experienceMonths < 6) return 1 / 3;
    if (experienceMonths < 24) return 2 / 3;
    return 1;
  }

  private buildSnapshot(
    liveHistory: Map<string, FairnessHistoryVO>,
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const [id, h] of liveHistory) snap[id] = h.computeRawScore();
    return snap;
  }
}
