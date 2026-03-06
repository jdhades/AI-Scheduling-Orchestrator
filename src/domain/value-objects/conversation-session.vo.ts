import { DomainError } from '../errors/domain.error';
import { IntentEntities, IntentType } from './conversation-intent.vo';

// ─── ConversationSessionVO ────────────────────────────────────────────────────

/**
 * Value Object representing the state of an ongoing multi-turn WhatsApp conversation.
 *
 * Stored in Redis with a TTL so abandoned sessions are cleaned automatically.
 * Immutable — mutations return new instances.
 */
export class ConversationSessionVO {
    /** TTL in seconds — 10 minutes */
    static readonly SESSION_TTL_SECONDS = 600;

    private constructor(
        private readonly _sessionId: string,
        private readonly _employeePhone: string,
        private readonly _companyId: string,
        private readonly _pendingIntent: IntentType | null,
        private readonly _collectedEntities: IntentEntities,
        private readonly _createdAt: Date,
        private readonly _expiresAt: Date,
    ) { }

    // ─── Factories ────────────────────────────────────────────────────────────

    static create(params: {
        employeePhone: string;
        companyId: string;
    }): ConversationSessionVO {
        if (!params.employeePhone) throw new DomainError('employeePhone is required');
        if (!params.companyId) throw new DomainError('companyId is required');

        const now = new Date();
        const expiresAt = new Date(now.getTime() + ConversationSessionVO.SESSION_TTL_SECONDS * 1000);
        const sessionId = `${params.employeePhone}-${now.getTime()}`;

        return new ConversationSessionVO(
            sessionId,
            params.employeePhone,
            params.companyId,
            null,
            {},
            now,
            expiresAt,
        );
    }

    /** Reconstitutes from a Redis-persisted JSON snapshot. */
    static fromSnapshot(data: {
        sessionId: string;
        employeePhone: string;
        companyId: string;
        pendingIntent: IntentType | null;
        collectedEntities: IntentEntities;
        createdAt: string;
        expiresAt: string;
    }): ConversationSessionVO {
        return new ConversationSessionVO(
            data.sessionId,
            data.employeePhone,
            data.companyId,
            data.pendingIntent,
            data.collectedEntities,
            new Date(data.createdAt),
            new Date(data.expiresAt),
        );
    }

    // ─── Accessors ────────────────────────────────────────────────────────────

    getSessionId(): string { return this._sessionId; }
    getEmployeePhone(): string { return this._employeePhone; }
    getCompanyId(): string { return this._companyId; }
    getPendingIntent(): IntentType | null { return this._pendingIntent; }
    getCollectedEntities(): Readonly<IntentEntities> { return { ...this._collectedEntities }; }
    getCreatedAt(): Date { return this._createdAt; }
    getExpiresAt(): Date { return this._expiresAt; }

    // ─── Business logic ───────────────────────────────────────────────────────

    isExpired(): boolean {
        return new Date() > this._expiresAt;
    }

    /**
     * Returns a new session instance with the given intent and merged entities.
     * Entities from the new intent overwrite existing ones if both are present.
     */
    withIntent(intent: IntentType, entities: IntentEntities): ConversationSessionVO {
        return new ConversationSessionVO(
            this._sessionId,
            this._employeePhone,
            this._companyId,
            intent,
            { ...this._collectedEntities, ...entities },
            this._createdAt,
            this._expiresAt,
        );
    }

    /** Serializes to a plain object for Redis storage. */
    toSnapshot(): object {
        return {
            sessionId: this._sessionId,
            employeePhone: this._employeePhone,
            companyId: this._companyId,
            pendingIntent: this._pendingIntent,
            collectedEntities: this._collectedEntities,
            createdAt: this._createdAt.toISOString(),
            expiresAt: this._expiresAt.toISOString(),
        };
    }
}
