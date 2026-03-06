/**
 * Domain Event: A shift swap has been requested by an employee.
 *
 * Published by SwapShiftHandler after validating the request.
 * Triggers: notification to the target employee asking for acceptance.
 */
export class ShiftSwapRequestedEvent {
    constructor(
        readonly requesterId: string,
        readonly targetEmployeeId: string,
        readonly shiftId: string,
        readonly companyId: string,
        readonly swapRequestId: string,
    ) { }
}
