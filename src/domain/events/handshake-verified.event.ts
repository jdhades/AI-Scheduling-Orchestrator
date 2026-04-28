export class HandshakeVerifiedEvent {
  constructor(
    public readonly employeeId: string,
    public readonly phone: string,
  ) {}
}
