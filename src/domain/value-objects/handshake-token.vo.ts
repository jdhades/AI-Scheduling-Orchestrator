/**
 * Value Object: HandshakeToken
 *
 * Representa el token temporal usado para vincular un número de WhatsApp
 * con un empleado registrado en el sistema.
 *
 * Invariantes:
 *  - El token debe ser un UUID v4 válido
 *  - El token tiene una expiración (TTL configurable, default 15 min)
 *  - Un token expirado no puede ser verificado
 *
 * 💡 DDD: La lógica de expiración vive en el Value Object,
 *         no en el handler ni en el servicio. El dominio es el experto.
 */
export class HandshakeToken {
    private static readonly UUID_REGEX =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    private constructor(
        public readonly value: string,
        public readonly expiresAt: Date,
    ) { }

    /**
     * Crea un HandshakeToken con un UUID v4 y TTL en minutos.
     * Se espera que el UUID sea generado externamente (uuid library)
     * para mantener el dominio testeable sin side effects.
     */
    static create(token: string, ttlMinutes = 15): HandshakeToken {
        if (!HandshakeToken.UUID_REGEX.test(token)) {
            throw new Error('HandshakeToken must be a valid UUID v4');
        }
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
        return new HandshakeToken(token, expiresAt);
    }

    isExpired(): boolean {
        return Date.now() > this.expiresAt.getTime();
    }

    equals(other: HandshakeToken): boolean {
        return this.value === other.value;
    }
}
