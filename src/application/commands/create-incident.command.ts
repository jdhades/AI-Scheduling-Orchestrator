export class CreateIncidentCommand {
    constructor(
        public readonly companyId: string,
        public readonly employeeId: string,
        public readonly message: string,
        public readonly mediaUrl: string,
    ) { }
}
