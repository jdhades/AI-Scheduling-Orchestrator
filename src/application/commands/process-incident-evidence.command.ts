export class ProcessIncidentEvidenceCommand {
    constructor(
        public readonly incidentId: string,
        public readonly employeeId: string,
        public readonly mediaUrl: string,
    ) { }
}
