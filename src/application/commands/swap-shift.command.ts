export class SwapShiftCommand {
  constructor(
    readonly requesterId: string,
    readonly assignmentId: string,
    readonly targetEmployeeId: string,
    readonly targetAssignmentId: string,
    readonly companyId: string,
  ) {}
}
