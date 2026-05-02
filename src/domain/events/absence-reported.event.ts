/**
 * Domain Event: An employee has reported an absence for a period
 * (single-day or multi-day).
 *
 * Published by AbsenceReportCreator after persisting the report and
 * deleting the affected assignments. Triggers:
 *   - isUrgent=true  → immediate manager alert via WhatsApp.
 *   - isUrgent=false → standard notification to manager.
 *
 * Phase 17.5 — el evento ahora carga el período completo y el listado
 * de assignments afectados para que el handler pueda renderear el
 * mensaje con nombres de empleado/turnos en vez de UUIDs.
 *
 * `shiftId` se mantiene como first-affected-id para backward compat
 * con consumers legacy (lo deprecamos cuando ya no haya consumers que
 * lo lean).
 */
export class AbsenceReportedEvent {
  constructor(
    readonly employeeId: string,
    readonly shiftId: string,
    readonly reason: string,
    readonly companyId: string,
    readonly isUrgent: boolean,
    readonly startDate: string = '',
    readonly endDate: string = '',
    readonly deletedAssignmentIds: string[] = [],
  ) {}
}
