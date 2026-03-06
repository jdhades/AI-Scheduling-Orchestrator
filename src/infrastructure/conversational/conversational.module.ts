import { Module } from '@nestjs/common';
import { GeminiConversationalService } from './gemini-conversational.service';
import { ConversationSessionRepository } from './conversation-session.repository';
import { CONVERSATIONAL_SERVICE } from '../../domain/services/conversational.service.interface';
import { RedisModule } from '../redis/redis.module';
import { ConfigModule } from '@nestjs/config';

/**
 * ConversationalModule — Infrastructure Layer
 *
 * Provides:
 *   - CONVERSATIONAL_SERVICE → GeminiConversationalService
 *   - ConversationSessionRepository (uses REDIS_CLIENT from RedisModule)
 */
@Module({
    imports: [ConfigModule, RedisModule],
    providers: [
        {
            provide: CONVERSATIONAL_SERVICE,
            useClass: GeminiConversationalService,
        },
        ConversationSessionRepository,
    ],
    exports: [CONVERSATIONAL_SERVICE, ConversationSessionRepository],
})
export class ConversationalModule { }
