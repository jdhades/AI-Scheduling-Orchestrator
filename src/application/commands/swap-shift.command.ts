export class SwapShiftCommand {
    constructor(
        readonly requesterId: string,
        readonly targetEmployeePhone: string,
        readonly shiftId: string,
        readonly companyId: string,
    ) { }
}
