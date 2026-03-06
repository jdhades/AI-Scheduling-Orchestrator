import { AggregateRoot } from '@nestjs/cqrs';
import { HandshakeToken } from '../value-objects/handshake-token.vo';
import { HandshakeInitiatedEvent } from '../events/handshake-initiated.event';
import { HandshakeVerifiedEvent } from '../events/handshake-verified.event';

/**
 * Aggregate: WhatsappHandshake
 *
 * Gestiona el ciclo de vida del proceso de vinculación segura
 * entre un empleado y su número de WhatsApp.
 *
 * Estados posibles:
 *   pending → verified | expired
 *
 * Invariantes del dominio:
 *  - Un token expirado no puede ser verificado
 *  - Un handshake ya verificado no puede verificarse de nuevo
 *  - El token en la verificación debe coincidir exactamente
 *
 * 💡 UUID Handshake flow:
 *   1. initiate()  → genera token → dispara HandshakeInitiatedEvent
 *   2. verify()    → valida token → dispara HandshakeVerifiedEvent
 *   3. El listener de HandshakeVerifiedEvent actualiza whatsapp_verified en DB
 */
export class WhatsappHandshake extends AggregateRoot {
    private verified = false;

    private constructor(
        public readonly id: string,
        public readonly employeeId: string,
        public readonly phone: string,
        private readonly token: HandshakeToken,
    ) { super(); }

    /**
     * Factory: inicia el handshake y despacha el evento para que
     * el listener envíe el token al WhatsApp del empleado.
     */
    static initiate(
        id: string,
        employeeId: string,
        phone: string,
        token: HandshakeToken,
    ): WhatsappHandshake {
        const handshake = new WhatsappHandshake(id, employeeId, phone, token);
        handshake.apply(new HandshakeInitiatedEvent(employeeId, phone, token.value));
        return handshake;
    }

    /**
     * Reconstituye el aggregate desde persistencia SIN disparar eventos.
     * Usado exclusivamente por los repositorios al leer de la DB.
     */
    static fromPersistence(data: {
        id: string;
        employeeId: string;
        phone: string;
        token: HandshakeToken;
        verified: boolean;
    }): WhatsappHandshake {
        const handshake = new WhatsappHandshake(data.id, data.employeeId, data.phone, data.token);
        handshake.verified = data.verified;
        return handshake;
    }


    /**
     * Verifica el token entregado por el empleado.
     * Aplica todas las reglas de negocio del dominio.
     */
    verify(providedToken: string): void {
        if (this.verified) {
            throw new Error('Handshake already verified');
        }

        if (this.token.isExpired()) {
            throw new Error('Handshake token has expired');
        }

        if (this.token.value !== providedToken) {
            throw new Error('Invalid handshake token');
        }

        this.verified = true;
        this.apply(new HandshakeVerifiedEvent(this.employeeId, this.phone));
    }

    isVerified(): boolean {
        return this.verified;
    }

    isExpired(): boolean {
        return this.token.isExpired();
    }
}
