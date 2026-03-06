import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ConversationSessionVO } from '../../domain/value-objects/conversation-session.vo';

/**
 * ConversationSessionRepository
 *
 * Manages multi-turn conversation state in Redis with automatic TTL.
 * Uses the existing REDIS_CLIENT from RedisModule — no new connection.
 *
 * Key pattern: conversation:session:{phone}
 */
@Injectable()
export class ConversationSessionRepository {
    private readonly logger = new Logger(ConversationSessionRepository.name);
    private static readonly KEY_PREFIX = 'conversation:session:';

    constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) { }

    async getSession(phone: string): Promise<ConversationSessionVO | null> {
        const key = this._key(phone);
        try {
            const raw = await this.redis.get(key);
            if (!raw) return null;

            const data = JSON.parse(raw) as Parameters<typeof ConversationSessionVO.fromSnapshot>[0];
            const session = ConversationSessionVO.fromSnapshot(data);

            // Guard against stale sessions that Redis hasn't evicted yet
            if (session.isExpired()) {
                await this.redis.del(key);
                return null;
            }

            return session;
        } catch (err) {
            this.logger.error(`getSession(${phone}) failed: ${(err as Error).message}`);
            return null;
        }
    }

    async saveSession(session: ConversationSessionVO): Promise<void> {
        const key = this._key(session.getEmployeePhone());
        try {
            await this.redis.set(
                key,
                JSON.stringify(session.toSnapshot()),
                'EX',
                ConversationSessionVO.SESSION_TTL_SECONDS,
            );
        } catch (err) {
            this.logger.error(`saveSession(${session.getEmployeePhone()}) failed: ${(err as Error).message}`);
        }
    }

    async clearSession(phone: string): Promise<void> {
        try {
            await this.redis.del(this._key(phone));
        } catch (err) {
            this.logger.error(`clearSession(${phone}) failed: ${(err as Error).message}`);
        }
    }

    private _key(phone: string): string {
        return `${ConversationSessionRepository.KEY_PREFIX}${phone}`;
    }
}
