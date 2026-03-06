export class EmployeeRegisteredEvent {
    constructor(
        public readonly employeeId: string,
        public readonly companyId: string,
        public readonly phone: string
    ) { }
}