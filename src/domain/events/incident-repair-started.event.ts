export class IncidentRepairStartedEvent {
    public readonly timestamp: Date;

    constructor(
        public readonly incidentId: string,
        public readonly companyId: string,
        public readonly employeeId: string,
        public readonly payload: {
            affectedShiftsIds: string[];
        },
    ) {
        this.timestamp = new Date();
    }
}
