import { WhatsappHandshake } from '../aggregates/whatsapp-handshake.aggregate';

/**
 * IHandshakeRepository — Port (DDD)
 */
export const HANDSHAKE_REPOSITORY = 'HANDSHAKE_REPOSITORY';

export interface IHandshakeRepository {
    save(handshake: WhatsappHandshake, tokenValue: string, expiresAt: Date): Promise<void>;
    findById(id: string): Promise<{ employeeId: string; phone: string; token: string; expiresAt: Date; verified: boolean } | null>;
    markVerified(handshakeId: string): Promise<void>;
}
