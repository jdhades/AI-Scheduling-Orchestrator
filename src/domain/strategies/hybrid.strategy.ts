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
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';
import {
  buildSkillIndex,
  filterCandidatesForShift,
  type BusySlot,
} from './shared/strategy-helpers';

export interface HybridWeights {
  /** Peso del factor de costo en la fórmula (default: 0.3) */
  costWeight: number;
  /** Peso del factor de fairness en la fórmula (default: 0.5) */
  fairnessWeight: number;
  /** Peso del factor de demanda en la fórmula (default: 0.2) */
  demandWeight: number;
}

// TODO(config-per-tenant): pesos hardcodeados — definen la filosofía de optimización
// (cost vs fairness vs demand). Cada empresa debería poder ajustarlos. Mover a config
// por compañía o exponer endpoint admin.
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
      // Si la capacidad es null, repartimos equitativamente los empleados entre los turnos sin capacidad de ese día
      // TODO(config-per-tenant): fórmula ceil(employees/turnos) hardcodeada. Otras empresas
      // podrían querer floor, promedio, o distribución ponderada por skill.
      let dynamicCapacity = Number.MAX_SAFE_INTEGER;
      if (shift.requiredEmployees === null) {
        const startDay = shift.startTime.toISOString().split('T')[0];
        const dynamicShiftsToday = sortedShifts.filter(
          (s) => s.startTime.toISOString().split('T')[0] === startDay && s.requiredEmployees === null
        ).length;
        dynamicCapacity = dynamicShiftsToday > 0 ? Math.ceil(employees.length / dynamicShiftsToday) : 1;
      }
      
      const targetCapacity = shift.requiredEmployees ?? dynamicCapacity;
      let assignedToThisShift = 0;

      while (assignedToThisShift < targetCapacity) {
        const candidates = this.getCandidates(
          shift,
          employees,
          skillIndex,
          busySlots,
          activeConstraints,
          workingTimePolicies,
          multiShiftPermits,
        );

        if (candidates.length === 0) {
          if (assignedToThisShift === 0 && targetCapacity !== Number.MAX_SAFE_INTEGER) {
            // Solo marcarlo como no cubierto si no llegamos a cubrir ni 1 habiéndolo requerido.
            unfilledShifts.push(shift);
          }
          break; // No hay más gente que pueda tomar este turno
        }

        const ranked = candidates.sort((a, b) => {
          const scoreA = this.totalScore(
            a,
            shift,
            liveHistory.get(a.id),
            maxRawFairness,
            activeConstraints,
          );
          const scoreB = this.totalScore(
            b,
            shift,
            liveHistory.get(b.id),
            maxRawFairness,
            activeConstraints,
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

        assignedToThisShift++;
      }
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
    constraints: SemanticConstraint[] = [],
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

    // Soft Semantic Constraint (weight=1): penalizar score sin bloquear
    const hasSoftBlock = constraints.some(
      (c) =>
        c.weight === 1 &&
        c.employeeId === employee.id &&
        (!c.shiftId || c.shiftId === shift.id),
    );
    // TODO(config-per-tenant): factor 1.5 hardcodeado — severidad de penalización
    // de soft constraints. Algunas empresas querrán 1.1 (más permisivo) o 2.0 (más estricto).
    const semanticPenalty = hasSoftBlock ? 1.5 : 1;

    return (
      (this.weights.costWeight * costFactor +
        this.weights.fairnessWeight * fairnessFactor +
        this.weights.demandWeight * demandFactor) *
      preferenceMultiplier *
      semanticPenalty
    );
  }

  // TODO(config-per-tenant): umbrales 6/24 meses para junior/intermediate/senior están
  // hardcodeados. Cada empresa tiene su propia escala de seniority.
  private normalizeCost(experienceMonths: number): number {
    if (experienceMonths < 6) return 1 / 3; // junior
    if (experienceMonths < 24) return 2 / 3; // intermediate
    return 1; // senior
  }

  private getCandidates(
    shift: Shift,
    employees: Employee[],
    skillIndex: Map<string, Employee[]>,
    busySlots: Map<string, BusySlot[]>,
    constraints: SemanticConstraint[] = [],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
  ): Employee[] {
    return filterCandidatesForShift({
      shift,
      employees,
      skillIndex,
      busySlots,
      constraints,
      workingTimePolicies,
      multiShiftPermits,
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
