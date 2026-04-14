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
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';
import {
  buildSkillIndex,
  filterCandidatesForShift,
  type BusySlot,
} from './shared/strategy-helpers';

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

  // TODO(config-per-tenant): EXPERIENCE_COST hardcodeado (junior=1, intermediate=2, senior=3).
  // Debería reflejar la escala salarial real de cada empresa, no ratios genéricos.
  private static readonly EXPERIENCE_COST: Record<string, number> = {
    junior: 1,
    intermediate: 2,
    senior: 3,
  };

  // TODO(config-per-tenant): umbral 600/1000 y factor 1.2 (+20%) son política interna
  // de fairness — cada empresa debería ajustarlos. Exponer como config por compañía.
  private static readonly FAIRNESS_PENALTY_THRESHOLD = 600; // de 1000
  private static readonly FAIRNESS_PENALTY_FACTOR = 1.2; // +20%

  generate(
    employees: Employee[],
    shifts: Shift[],
    histories: FairnessHistoryVO[],
    semanticRules?: SemanticConstraint[],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
  ): StrategyResult {
    // Índice de historial por employeeId — O(1) lookup
    const historyIndex = new Map<string, FairnessHistoryVO>(
      histories.map((h) => [h.employeeId, h]),
    );

    // Snapshot de scores actuales para embeber en c/asignación
    const snapshot = this.buildSnapshot(histories);

    // Rastrear ocupación: employeeId → slots asignados
    const busySlots = new Map<string, BusySlot[]>();
    for (const e of employees) busySlots.set(e.id, []);

    // Pre-indexar employees por skill: skillId → Employee[]
    const skillIndex = buildSkillIndex(employees);

    const activeConstraints = semanticRules ?? [];

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
        activeConstraints,
        workingTimePolicies,
        multiShiftPermits,
      );

      if (candidates.length === 0) {
        unfilledShifts.push(shift);
        continue;
      }

      // Ordenar por costo efectivo (base + penalización por fairness + soft semantic)
      const ranked = candidates.sort((a, b) => {
        const costA = this.effectiveCost(a, shift, historyIndex.get(a.id), activeConstraints);
        const costB = this.effectiveCost(b, shift, historyIndex.get(b.id), activeConstraints);
        return costA - costB;
      });

      const winner = ranked[0];
      busySlots.get(winner.id)!.push(shift);

      assignments.push(
        ShiftAssignment.create({
          id: randomUUID(),
          templateId: shift.templateId ?? '',
          date: shift.startTime.toISOString().split('T')[0],
          employeeId: winner.id,
          companyId: shift.companyId,
          origin: 'membership',
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
    constraints: SemanticConstraint[] = [],
  ): number {
    // TODO(config-per-tenant): umbrales 24/6 meses para senior/intermediate/junior
    // duplicados con HybridStrategy.normalizeCost. Unificar y configurar por empresa.
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

    // Soft Semantic Constraint (weight=1): penalizar pero no bloquear
    const hasSoftBlock = constraints.some(
      (c) =>
        c.weight === 1 &&
        c.employeeId === employee.id &&
        (!c.shiftId || c.shiftId === shift.id),
    );
    // TODO(config-per-tenant): factor 1.5 hardcodeado y duplicado con HybridStrategy.
    const semanticPenalty = hasSoftBlock ? 1.5 : 1;

    return baseCost * fairnessMultiplier * preferenceMultiplier * semanticPenalty;
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
    histories: FairnessHistoryVO[],
  ): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const h of histories) snap[h.employeeId] = h.computeRawScore();
    return snap;
  }
}
