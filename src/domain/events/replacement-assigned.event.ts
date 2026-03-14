export class ReplacementAssignedEvent {
    public readonly timestamp: Date;

    constructor(
        public readonly incidentId: string,
        public readonly companyId: string,
        public readonly employeeId: string,
        public readonly payload: {
            replacementEmployeeId: string;
            shiftId: string;
            strategy: string;
        },
    ) {
        this.timestamp = new Date();
    }
}
