export class ReportAbsenceCommand {
  constructor(
    readonly employeeId: string,
    readonly assignmentId: string,
    readonly reason: string,
    readonly companyId: string,
  ) {}
}
