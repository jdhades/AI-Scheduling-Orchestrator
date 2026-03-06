export class HandshakeInitiatedEvent {
    constructor(
        public readonly employeeId: string,
        public readonly phone: string,
        public readonly token: string,
    ) { }
}
