import type { StrategyType } from '../strategies/scheduling-strategy.interface';

/** Origen de una asignación en el modelo de membresías. */
export type AssignmentOrigin = 'membership' | 'override' | 'exception';

/**
 * ShiftAssignment — Domain Aggregate
 *
 * Asignación de un empleado a un slot virtual (template + fecha concreta).
 * No referencia `shifts.id` (esa tabla fue eliminada). La instancia del turno
 * es virtual: se materializa en memoria al generar el horario.
 *
 * `origin`:
 *  - 'membership'  → derivada de `shift_memberships` (flujo por defecto)
 *  - 'override'    → puesta manualmente por el manager
 *  - 'exception'   → cambio puntual al patrón (swap, take-open, etc.)
 */
export class ShiftAssignment {
  private constructor(
    public readonly id: string,
    public readonly templateId: string,
    public readonly date: string, // ISO "YYYY-MM-DD"
    public readonly employeeId: string,
    public readonly companyId: string,
    public readonly origin: AssignmentOrigin,
    public readonly assignedAt: Date,
    public readonly assignedByStrategy: StrategyType,
    public readonly fairnessSnapshot: Record<string, number>,
    public readonly actualStartTime?: Date,
    public readonly actualEndTime?: Date,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`ShiftAssignment.date must be YYYY-MM-DD, got: ${date}`);
    }
    if (actualStartTime && actualEndTime && actualEndTime <= actualStartTime) {
      throw new Error('actualEndTime must be after actualStartTime');
    }
  }

  /**
   * Identificador estable del slot virtual (no persistido).
   * Útil para agrupar/filtrar assignments que comparten el mismo slot.
   */
  get slotKey(): string {
    return `${this.templateId}|${this.date}`;
  }

  /**
   * Alias deprecated para compatibilidad temporal con consumers que aún usan
   * `assignment.shiftId`. Devuelve `slotKey` — NO es el UUID del row en BD.
   * Para operaciones CRUD sobre la persistencia, usar `.id`.
   *
   * @deprecated use `templateId + date` explicitly, or `.id` for DB operations.
   */
  get shiftId(): string {
    return this.slotKey;
  }

  static create(props: {
    id: string;
    templateId: string;
    date: string;
    employeeId: string;
    companyId: string;
    origin: AssignmentOrigin;
    strategyType: StrategyType;
    fairnessSnapshot: Record<string, number>;
    actualStartTime?: Date;
    actualEndTime?: Date;
  }): ShiftAssignment {
    return new ShiftAssignment(
      props.id,
      props.templateId,
      props.date,
      props.employeeId,
      props.companyId,
      props.origin,
      new Date(),
      props.strategyType,
      { ...props.fairnessSnapshot },
      props.actualStartTime,
      props.actualEndTime,
    );
  }

  static fromPersistence(props: {
    id: string;
    templateId: string;
    date: string;
    employeeId: string;
    companyId: string;
    origin: AssignmentOrigin;
    assignedAt: Date;
    assignedByStrategy: StrategyType;
    fairnessSnapshot: Record<string, number>;
    actualStartTime?: Date;
    actualEndTime?: Date;
  }): ShiftAssignment {
    return new ShiftAssignment(
      props.id,
      props.templateId,
      props.date,
      props.employeeId,
      props.companyId,
      props.origin,
      props.assignedAt,
      props.assignedByStrategy,
      { ...props.fairnessSnapshot },
      props.actualStartTime,
      props.actualEndTime,
    );
  }
}
