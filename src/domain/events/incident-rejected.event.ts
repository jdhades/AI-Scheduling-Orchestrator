export class IncidentRejectedEvent {
    public readonly timestamp: Date;

    constructor(
        public readonly incidentId: string,
        public readonly companyId: string,
        public readonly employeeId: string,
        public readonly payload: {
            reason: string;
        },
    ) {
        this.timestamp = new Date();
    }
}
