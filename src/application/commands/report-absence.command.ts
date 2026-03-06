export class ReportAbsenceCommand {
    constructor(
        readonly employeeId: string,
        readonly shiftId: string,
        readonly reason: string,
        readonly companyId: string,
    ) { }
}
