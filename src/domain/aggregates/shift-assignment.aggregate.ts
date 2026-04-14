import type { StrategyType } from '../strategies/scheduling-strategy.interface';

/**
 * ShiftAssignment — Domain Aggregate
 *
 * Registra la asignación de un turno específico a un empleado.
 * Incluye un snapshot del fairness score al momento de la asignación,
 * lo que permite auditoría histórica del algoritmo.
 *
 * NOTE (rework en progreso): este aggregate está en el medio de un refactor
 * del modelo de shifts (ver /home/jhav/.claude/plans/gleaming-dazzling-turtle.md).
 * La tabla `shift_assignments` en BD ya NO tiene `shift_id` — ahora tiene
 * `template_id + date + origin`. La migración del aggregate a esa nueva shape
 * se hará en Day 2b del plan. Mientras tanto, el repo mapea en memoria para
 * mantener compatibilidad con el código consumidor.
 */
export class ShiftAssignment {
  private constructor(
    public readonly id: string,
    public readonly shiftId: string,
    public readonly employeeId: string,
    public readonly companyId: string,
    public readonly assignedAt: Date,
    public readonly assignedByStrategy: StrategyType,
    /**
     * Snapshot de todos los fairness scores del equipo en el momento de asignar.
     * Clave: employeeId, Valor: FairnessScore.value
     */
    public readonly fairnessSnapshot: Record<string, number>,
    public readonly actualStartTime?: Date,
    public readonly actualEndTime?: Date,
  ) {
    if (actualStartTime && actualEndTime && actualEndTime <= actualStartTime) {
      throw new Error('actualEndTime must be after actualStartTime');
    }
  }

  static create(props: {
    id: string;
    shiftId: string;
    employeeId: string;
    companyId: string;
    strategyType: StrategyType;
    fairnessSnapshot: Record<string, number>;
    actualStartTime?: Date;
    actualEndTime?: Date;
  }): ShiftAssignment {
    return new ShiftAssignment(
      props.id,
      props.shiftId,
      props.employeeId,
      props.companyId,
      new Date(),
      props.strategyType,
      { ...props.fairnessSnapshot },
      props.actualStartTime,
      props.actualEndTime,
    );
  }

  static fromPersistence(props: {
    id: string;
    shiftId: string;
    employeeId: string;
    companyId: string;
    assignedAt: Date;
    assignedByStrategy: StrategyType;
    fairnessSnapshot: Record<string, number>;
    actualStartTime?: Date;
    actualEndTime?: Date;
  }): ShiftAssignment {
    return new ShiftAssignment(
      props.id,
      props.shiftId,
      props.employeeId,
      props.companyId,
      props.assignedAt,
      props.assignedByStrategy,
      { ...props.fairnessSnapshot },
      props.actualStartTime,
      props.actualEndTime,
    );
  }
}
