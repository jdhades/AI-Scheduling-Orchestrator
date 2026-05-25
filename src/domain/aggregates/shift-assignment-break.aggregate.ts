/**
 * ShiftAssignmentBreak — Domain Aggregate
 *
 * Descanso intra-shift sobre un assignment concreto. Tiempos absolutos
 * UTC (alineados al wall-clock del shift, mismo storage que actual
 * Start/EndTime del assignment).
 *
 * Invariantes propias del aggregate:
 *   - endTime > startTime
 *   - duration > 0
 *
 * Invariantes que requieren contexto externo (validadas por el domain
 * service, no acá):
 *   - El break cabe dentro del assignment (start >= shift.start,
 *     end <= shift.end)
 *   - No overlap con otros breaks del mismo assignment
 *
 * `isPaid`:
 *   - false (default) → el empleado NO cobra esos minutos. Se restan
 *     del total de horas trabajadas en FairnessHistory.
 *   - true → cobra normal (ej. "coffee break" según convenio).
 */
export class ShiftAssignmentBreak {
  private constructor(
    public readonly id: string,
    public readonly assignmentId: string,
    public readonly companyId: string,
    public readonly startTime: Date,
    public readonly endTime: Date,
    public readonly isPaid: boolean,
    public readonly reason: string | null,
    public readonly createdAt: Date,
  ) {
    if (endTime.getTime() <= startTime.getTime()) {
      throw new Error('ShiftAssignmentBreak.endTime must be after startTime');
    }
  }

  static create(params: {
    id: string;
    assignmentId: string;
    companyId: string;
    startTime: Date;
    endTime: Date;
    isPaid?: boolean;
    reason?: string | null;
    createdAt?: Date;
  }): ShiftAssignmentBreak {
    return new ShiftAssignmentBreak(
      params.id,
      params.assignmentId,
      params.companyId,
      params.startTime,
      params.endTime,
      params.isPaid ?? false,
      params.reason ?? null,
      params.createdAt ?? new Date(),
    );
  }

  /** Duración del break en minutos. */
  durationMinutes(): number {
    return Math.round(
      (this.endTime.getTime() - this.startTime.getTime()) / 60000,
    );
  }

  /** True si el break tiene algún overlap con otro break. Inclusivo
   * en bordes: dos breaks que tocan endpoints (un end === otro start)
   * NO se consideran overlap — el break empieza apenas el anterior
   * termina, válido. */
  overlapsWith(other: ShiftAssignmentBreak): boolean {
    return (
      this.startTime.getTime() < other.endTime.getTime() &&
      other.startTime.getTime() < this.endTime.getTime()
    );
  }

  /** True si el break está completamente contenido en el rango
   * [shiftStart, shiftEnd]. Inclusivo en bordes. */
  isWithinShift(shiftStart: Date, shiftEnd: Date): boolean {
    return (
      this.startTime.getTime() >= shiftStart.getTime() &&
      this.endTime.getTime() <= shiftEnd.getTime()
    );
  }
}
