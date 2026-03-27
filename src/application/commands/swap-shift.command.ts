export class SwapShiftCommand {
  constructor(
    readonly requesterId: string,
    readonly shiftId: string,
    readonly targetEmployeeId: string,
    readonly targetShiftId: string,
    readonly companyId: string,
  ) {}
}
