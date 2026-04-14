/**
 * WorkingTimePolicyVO — límites de jornada efectivos para un empleado.
 *
 * Resultado del merge en `WorkingTimePolicyResolver` (employee → department → company → fallback).
 * Inmutable. Todos los campos en horas (decimales permitidos: ej. 7.5).
 */
export class WorkingTimePolicyVO {
  private constructor(
    public readonly maxHoursPerDay: number,
    public readonly maxHoursPerWeek: number,
  ) {
    if (maxHoursPerDay <= 0 || maxHoursPerDay > 24) {
      throw new Error(`maxHoursPerDay out of range: ${maxHoursPerDay}`);
    }
    if (maxHoursPerWeek <= 0 || maxHoursPerWeek > 168) {
      throw new Error(`maxHoursPerWeek out of range: ${maxHoursPerWeek}`);
    }
  }

  static create(params: {
    maxHoursPerDay: number;
    maxHoursPerWeek: number;
  }): WorkingTimePolicyVO {
    return new WorkingTimePolicyVO(
      params.maxHoursPerDay,
      params.maxHoursPerWeek,
    );
  }

  describe(): string {
    return `max ${this.maxHoursPerDay}h/día, ${this.maxHoursPerWeek}h/semana`;
  }
}

/** Overrides parciales en cualquier nivel de la jerarquía. NULL/undefined → heredar. */
export interface WorkingTimePolicyOverrides {
  maxHoursPerDay?: number | null;
  maxHoursPerWeek?: number | null;
}
