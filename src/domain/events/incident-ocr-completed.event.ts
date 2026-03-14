export class IncidentOCRCompletedEvent {
    public readonly timestamp: Date;

    constructor(
        public readonly incidentId: string,
        public readonly companyId: string,
        public readonly employeeId: string,
        public readonly payload: {
            ocrText: string;
            ocrConfidence: number;
        },
    ) {
        this.timestamp = new Date();
    }
}
