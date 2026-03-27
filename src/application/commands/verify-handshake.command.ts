export class VerifyHandshakeCommand {
  constructor(
    public readonly handshakeId: string,
    public readonly providedToken: string,
  ) {}
}
