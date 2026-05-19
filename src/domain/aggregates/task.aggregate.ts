/**
 * Task — Domain Aggregate
 *
 * Tarea con UN solo target: shift template o empleado.
 *
 * Modelo (2026-05-20):
 *   - target=template → tarea inherente a un template. Cualquier
 *     empleado que cubra ese template hereda la tarea.
 *   - target=employee → tarea individual del empleado, no atada a
 *     ningún turno particular.
 *
 * Estado: pending (is_done=false) → done (is_done=true). La transición
 * a done captura `completedAt` + `completedByEmployeeId`. No hay
 * "reopen" en v1 (si hace falta, se borra y se crea otra).
 */
export type TaskTarget =
  | { type: 'template'; shiftTemplateId: string }
  | { type: 'employee'; employeeId: string };

export class Task {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly title: string,
    public readonly description: string | null,
    public readonly isDone: boolean,
    public readonly target: TaskTarget,
    public readonly completedAt: Date | null,
    public readonly completedByEmployeeId: string | null,
    public readonly createdAt: Date,
  ) {
    if (!title.trim()) {
      throw new Error('Task.title is required');
    }
    if (title.length > 200) {
      throw new Error('Task.title cannot exceed 200 chars');
    }
    if (description && description.length > 2000) {
      throw new Error('Task.description cannot exceed 2000 chars');
    }
    if (isDone && completedAt === null) {
      throw new Error('Task marked done must have completedAt');
    }
    if (!isDone && completedAt !== null) {
      throw new Error('Task not done must not have completedAt');
    }
  }

  static create(params: {
    id: string;
    companyId: string;
    title: string;
    description?: string | null;
    target: TaskTarget;
    createdAt?: Date;
  }): Task {
    return new Task(
      params.id,
      params.companyId,
      params.title,
      params.description ?? null,
      false,
      params.target,
      null,
      null,
      params.createdAt ?? new Date(),
    );
  }

  /** Reconstruye desde una fila persistida. */
  static fromPersistence(params: {
    id: string;
    companyId: string;
    title: string;
    description: string | null;
    isDone: boolean;
    target: TaskTarget;
    completedAt: Date | null;
    completedByEmployeeId: string | null;
    createdAt: Date;
  }): Task {
    return new Task(
      params.id,
      params.companyId,
      params.title,
      params.description,
      params.isDone,
      params.target,
      params.completedAt,
      params.completedByEmployeeId,
      params.createdAt,
    );
  }

  /** Marca como done. Devuelve nuevo Task (aggregate inmutable). */
  markDone(completedByEmployeeId: string | null, at: Date = new Date()): Task {
    if (this.isDone) {
      throw new Error('Task is already done');
    }
    return new Task(
      this.id,
      this.companyId,
      this.title,
      this.description,
      true,
      this.target,
      at,
      completedByEmployeeId,
      this.createdAt,
    );
  }
}
