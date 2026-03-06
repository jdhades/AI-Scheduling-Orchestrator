/**
 * Domain Event: An employee has reported an absence for an assigned shift.
 *
 * Published by ReportAbsenceHandler after recording the absence.
 * Triggers:
 *   - isUrgent=true  → immediate manager alert via WhatsApp
 *   - isUrgent=false → standard notification to manager
 */
export class AbsenceReportedEvent {
    constructor(
        readonly employeeId: string,
        readonly shiftId: string,
        readonly reason: string,
        readonly companyId: string,
        readonly isUrgent: boolean,
    ) { }
}
