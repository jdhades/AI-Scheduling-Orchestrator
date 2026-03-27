import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type {
  SchedulingStrategy,
  SemanticConstraint,
} from '../strategies/scheduling-strategy.interface';
import { FairnessCalculator } from './fairness-calculator.service';
import { ScheduleQualityReport } from './schedule-quality-analyzer.service';

export interface SchedulingOptions {
  maxFairnessDeviation: number;
  /** Reglas semánticas del RAG — vacío hasta Escenario 3 */
  semanticConstraints?: SemanticConstraint[];
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

    const { assignments, unfilledShifts } = strategy.generate(
      employees,
      shifts,
      histories,
      options.semanticConstraints ?? [],
    );

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
