import { Module } from '@nestjs/common';
import { QwenConversationalService } from './qwen-conversational.service';
import { GeminiConversationalService } from './gemini-conversational.service';
import { ConversationSessionRepository } from './conversation-session.repository';
import { ConfigService } from '@nestjs/config';
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
    QwenConversationalService,
    GeminiConversationalService,
    {
      provide: CONVERSATIONAL_SERVICE,
      inject: [ConfigService, QwenConversationalService, GeminiConversationalService],
      useFactory: (config: ConfigService, qwen: QwenConversationalService, gemini: GeminiConversationalService) => {
        return config.get('ai.activeProvider') === 'gemini' ? gemini : qwen;
      },
    },
    ConversationSessionRepository,
  ],
  exports: [CONVERSATIONAL_SERVICE, ConversationSessionRepository],
})
export class ConversationalModule {}
