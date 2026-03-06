import { HandshakeToken } from '../../domain/value-objects/handshake-token.vo';

export class InitiateHandshakeCommand {
    constructor(
        public readonly handshakeId: string,
        public readonly employeeId: string,
        public readonly phone: string,
        public readonly token: HandshakeToken,
    ) { }
}
