import { AggregateRoot } from '@nestjs/cqrs';
import type { Shift } from './shift.aggregate';
import type { ShiftAssignment } from './shift-assignment.aggregate';
import type { Employee } from './employee.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type {
  SchedulingStrategy,
  SemanticConstraint,
} from '../strategies/scheduling-strategy.interface';
import {
  SchedulingEngine,
  type SchedulingOptions,
  type ScheduleResult,
} from '../services/scheduling-engine.service';
import { FairnessCalculator } from '../services/fairness-calculator.service';

/**
 * ScheduleAggregate — Aggregate Root del Escenario 2
 *
 * Encapsula y protege las invariantes del scheduling:
 *   - Un empleado no puede estar en dos turnos solapados
 *   - No se viola skill constraint
 *   - No se supera el max fairness deviation
 *
 * Emite ScheduleGeneratedEvent al finalizar con éxito.
 */
export class ScheduleAggregate extends AggregateRoot {
  private _assignments: ShiftAssignment[] = [];
  private _unfilledShifts: Shift[] = [];
  private _result: ScheduleResult | null = null;

  private constructor(
    public readonly companyId: string,
    public readonly weekStart: Date,
    private readonly engine: SchedulingEngine,
  ) {
    super();
  }

  static create(companyId: string, weekStart: Date): ScheduleAggregate {
    const calculator = new FairnessCalculator();
    const engine = new SchedulingEngine(calculator);
    return new ScheduleAggregate(companyId, weekStart, engine);
  }

  /**
   * Genera el horario completo delegando en el engine con la estrategia dada.
   */
  generate(
    employees: Employee[],
    shifts: Shift[],
    histories: FairnessHistoryVO[],
    strategy: SchedulingStrategy,
    options: SchedulingOptions,
  ): void {
    this._result = this.engine.run(
      shifts,
      employees,
      histories,
      strategy,
      options,
    );
    this._assignments = this._result.assignments;
    this._unfilledShifts = this._result.unfilledShifts;

    // Emitir evento de dominio
    this.apply({
      name: 'ScheduleGeneratedEvent',
      companyId: this.companyId,
      weekStart: this.weekStart,
      totalAssignments: this._assignments.length,
      unfilledShifts: this._unfilledShifts.length,
      strategyUsed: strategy.type,
      quality: this._result.quality,
    });
  }

  /**
   * Valida las invariantes del schedule generado.
   * Falla si hay empleados en dos turnos solapados.
   */
  validate(shifts: Shift[]): { valid: boolean; violations: string[] } {
    const violations: string[] = [];
    const byEmployee = new Map<string, ShiftAssignment[]>();

    for (const a of this._assignments) {
      if (!byEmployee.has(a.employeeId)) byEmployee.set(a.employeeId, []);
      byEmployee.get(a.employeeId)!.push(a);
    }

    // Detectar solapamientos (imposible si las estrategias funcionan bien)
    for (const [empId, assignments] of byEmployee) {
      for (let i = 0; i < assignments.length; i++) {
        for (let j = i + 1; j < assignments.length; j++) {
          const shiftA = shifts.find((s) => s.id === assignments[i].shiftId);
          const shiftB = shifts.find((s) => s.id === assignments[j].shiftId);

          if (shiftA && shiftB && shiftA.overlapsWith(shiftB)) {
            violations.push(
              `Overlap detected for employee ${empId}: shift ${assignments[i].shiftId} and ${assignments[j].shiftId}`,
            );
          }
        }
      }
    }

    return { valid: violations.length === 0, violations };
  }

  get assignments(): ShiftAssignment[] {
    return [...this._assignments];
  }
  get unfilledShifts(): Shift[] {
    return [...this._unfilledShifts];
  }
  get result(): ScheduleResult | null {
    return this._result;
  }
}
