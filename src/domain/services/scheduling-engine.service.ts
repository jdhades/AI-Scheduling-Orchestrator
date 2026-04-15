import { Logger } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type {
  SchedulingStrategy,
  SemanticConstraint,
} from '../strategies/scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../strategies/scheduling-strategy.interface';
import { FairnessCalculator } from './fairness-calculator.service';
import { ScheduleQualityReport } from './schedule-quality-analyzer.service';
import { SemanticConstraintInterpreter } from './semantic-constraint-interpreter';
import { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';

export interface SchedulingOptions {
  maxFairnessDeviation: number;
  /** Reglas semánticas del RAG — vacío hasta Escenario 3 */
  semanticConstraints?: SemanticConstraint[];
  /** Working time policies resueltas por jerarquía (employee → dept → tenant). */
  workingTimePolicies?: Map<string, import('../value-objects/working-time-policy.vo').WorkingTimePolicyVO>;
  /** `${employeeId}|YYYY-MM-DD` autorizados a tener 2+ turnos ese día. */
  multiShiftPermits?: Set<string>;
}

export interface ScheduleResult {
  assignments: ShiftAssignment[];
  unfilledShifts: Shift[];
  quality: ScheduleQualityReport;
}

/**
 * SchedulingEngine — Domain Service
 *
 * Orquesta el proceso completo de generación de horarios:
 *   1. Pre-valida que haya empleados y turnos
 *   2. Delega la asignación a la estrategia inyectada
 *   3. Calcula el reporte de calidad sobre el resultado
 *
 * El engine no decide cómo asignar — eso es responsabilidad de la estrategia.
 * El engine garantiza que el resultado es auditable y medible.
 *
 * Performance: O(n log n) — dependiente de la estrategia. Las 3 estrategias
 * incluidas cumplen este requisito (pre-indexación con Map).
 */
export class SchedulingEngine {
  private readonly logger = new Logger(SchedulingEngine.name);

  constructor(private readonly fairnessCalc: FairnessCalculator) {}

  run(
    shifts: Shift[],
    employees: Employee[],
    histories: FairnessHistoryVO[],
    strategy: SchedulingStrategy,
    options: SchedulingOptions,
  ): ScheduleResult {
    if (employees.length === 0) {
      return {
        assignments: [],
        unfilledShifts: [...shifts],
        quality: this.emptyQualityReport(strategy.type),
      };
    }

    if (shifts.length === 0) {
      return {
        assignments: [],
        unfilledShifts: [],
        quality: this.emptyQualityReport(strategy.type),
      };
    }

    const slots: VirtualShiftSlot[] = shifts.map((s) =>
      VirtualShiftSlot.create({
        templateId: s.templateId ?? s.id,
        companyId: s.companyId,
        date: s.startTime.toISOString().split('T')[0],
        startTime: s.startTime,
        endTime: s.endTime,
        templateName: (s as unknown as { name?: string }).name ?? '',
        requiredSkillId: s.requiredSkillId ?? null,
        requiredEmployees: s.requiredEmployees ?? 1,
        demandScore: s.demandScore.value,
        undesirableWeight: (s.undesirableWeight as unknown as { value?: number }).value ?? Number(s.undesirableWeight),
      }),
    );
    const shiftBySlotKey = new Map<string, Shift>(
      slots.map((slot, i) => [slot.slotKey, shifts[i]]),
    );

    // Enriquecer constraints con IDs resueltos (employeeId, shiftId como slotKey)
    // antes de pasarlos a la estrategia.
    const rawConstraints = options.semanticConstraints ?? [];
    const resolvedConstraints = SemanticConstraintInterpreter.interpret(
      rawConstraints,
      employees,
      slots,
    );

    if (rawConstraints.length > 0) {
      const hardBlocks = resolvedConstraints.filter(
        (c) => c.weight >= 2 && c.employeeId === SEMANTIC_BLOCKED_ALL && c.shiftId,
      );
      const empBlocks = resolvedConstraints.filter(
        (c) => c.weight >= 2 && c.employeeId && c.employeeId !== SEMANTIC_BLOCKED_ALL,
      );
      const unresolved = resolvedConstraints.filter(
        (c) => !c.employeeId && !c.shiftId,
      );

      this.logger.log(
        `SemanticInterpreter: ${rawConstraints.length} raw → ${resolvedConstraints.length} resolved ` +
        `(${hardBlocks.length} full-shift blocks, ${empBlocks.length} employee blocks, ${unresolved.length} unresolved)`,
      );

      if (hardBlocks.length > 0) {
        hardBlocks.forEach((c) =>
          this.logger.log(`  BLOCKED shift=${c.shiftId} (all employees) — "${c.rule}"`),
        );
      }

      if (unresolved.length > 0) {
        unresolved.forEach((c) =>
          this.logger.warn(`  UNRESOLVED constraint (no shiftId/employeeId matched) — "${c.rule}"`),
        );
      }
    }

    const { assignments, unfilledSlots } = strategy.generate(
      employees,
      slots,
      histories,
      resolvedConstraints,
      options.workingTimePolicies,
      options.multiShiftPermits,
    );

    const unfilledShifts: Shift[] = unfilledSlots
      .map((slot) => shiftBySlotKey.get(slot.slotKey))
      .filter((s): s is Shift => s !== undefined);

    const quality = this.analyzeQuality(
      assignments,
      unfilledShifts,
      shifts,
      histories,
      strategy.type,
    );

    return { assignments, unfilledShifts, quality };
  }

  private analyzeQuality(
    assignments: ShiftAssignment[],
    unfilledShifts: Shift[],
    allShifts: Shift[],
    histories: FairnessHistoryVO[],
    strategyType: string,
  ): ScheduleQualityReport {
    const scores = this.fairnessCalc.computeAll(histories);
    const fairnessVariance = this.fairnessCalc.computeVariance([
      ...scores.values(),
    ]);

    const demandCoveragePercent =
      allShifts.length > 0
        ? Math.round((assignments.length / allShifts.length) * 100)
        : 100;

    return {
      fairnessVariance,
      skillViolations: 0, // validadas por las estrategias
      demandCoveragePercent,
      costProjection: 0, // costo real → pendiente integración con Payroll
      legalComplianceScore: 100, // si llegó aquí, pasó el ConflictResolver
      unfilledShiftsCount: unfilledShifts.length,
      generatedAt: new Date(),
      strategyUsed: strategyType,
    };
  }

  private emptyQualityReport(strategyType: string): ScheduleQualityReport {
    return {
      fairnessVariance: 0,
      skillViolations: 0,
      demandCoveragePercent: 100,
      costProjection: 0,
      legalComplianceScore: 100,
      unfilledShiftsCount: 0,
      generatedAt: new Date(),
      strategyUsed: strategyType,
    };
  }
}
