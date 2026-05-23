/**
 * CloneScheduleCommand
 *
 * Clona las assignments de `sourceWeekStart` a una o más semanas
 * destino. Las fechas se remapean por offset de día-de-semana
 * (lunes→lunes, etc.). Antes de insertar, el handler descarta:
 *
 *   - Asignaciones donde el empleado tiene un `day_off_request`
 *     APPROVED en la fecha destino.
 *   - Asignaciones donde el empleado tiene un `absence_report`
 *     activo cuyo rango cubre la fecha destino.
 *
 * Si `overwrite=false` (default) y una semana destino ya tiene
 * assignments, el handler tira CloneScheduleConflictError con el
 * count de existentes. Con `overwrite=true` borra esas assignments
 * primero (preservando otras semanas, scope estricto al target).
 *
 * Multi-week: una sola transacción lógica. Si una semana destino
 * falla por conflict y el caller no autorizó overwrite, el handler
 * NO toca ninguna — fail-fast antes de escribir.
 */
export class CloneScheduleCommand {
  constructor(
    public readonly companyId: string,
    public readonly sourceWeekStart: string, // YYYY-MM-DD
    public readonly targetWeekStarts: string[], // YYYY-MM-DD[]
    public readonly overwrite: boolean = false,
  ) {}
}

export class CloneScheduleConflictError extends Error {
  constructor(
    public readonly conflicts: Array<{ weekStart: string; existingCount: number }>,
  ) {
    super(
      `Target weeks already have assignments: ${conflicts
        .map((c) => `${c.weekStart} (${c.existingCount})`)
        .join(', ')}`,
    );
  }
}

export interface CloneScheduleSkippedItem {
  employeeId: string;
  date: string; // YYYY-MM-DD (target)
  reason: 'day_off' | 'absence';
}

export interface CloneScheduleResult {
  /** Cantidad de assignments efectivamente creadas. */
  created: number;
  /** Assignments NO creadas por conflictos en target weeks. */
  skipped: CloneScheduleSkippedItem[];
  /** Cantidad de assignments borradas por overwrite, por semana. Vacío si overwrite=false. */
  replaced: Array<{ weekStart: string; count: number }>;
}
