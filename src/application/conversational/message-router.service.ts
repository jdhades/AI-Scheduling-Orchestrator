import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { IConversationalService } from '../../domain/services/conversational.service.interface';
import { CONVERSATIONAL_SERVICE } from '../../domain/services/conversational.service.interface';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import { ConversationSessionRepository } from '../../infrastructure/conversational/conversation-session.repository';
import { ConversationSessionVO } from '../../domain/value-objects/conversation-session.vo';
import { ConversationIntentVO } from '../../domain/value-objects/conversation-intent.vo';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import { CommandMapperService } from './command-mapper.service';

export interface IncomingMessage {
    from: string;           // E.164 phone number of sender
    companyId: string;      // resolved from DB via phone lookup
    employeeId: string;     // resolved from DB
    body?: string;          // text body (if text message)
    mediaUrl?: string;      // Twilio media URL (if audio/image)
    mimeType?: string;      // MIME type of the media
    twilioSid: string;      // for Basic Auth when downloading audio
    twilioToken: string;
}

/**
 * MessageRouterService
 *
 * Orchestrates the full incoming-message pipeline:
 * 1. Detect message type (text | audio | unsupported)
 * 2. Call IConversationalService for classification
 * 3. Merge with existing Redis session (multi-turn)
 * 4. Map intent to CQRS Command
 * 5. Execute command / query
 * 6. Fire-and-forget WhatsApp reply
 */
@Injectable()
export class MessageRouterService {
    private readonly logger = new Logger(MessageRouterService.name);

    constructor(
        @Inject(CONVERSATIONAL_SERVICE)
        private readonly conversationalService: IConversationalService,
        @Inject(NOTIFICATION_SERVICE)
        private readonly notificationService: INotificationService,
        private readonly sessionRepository: ConversationSessionRepository,
        private readonly commandMapper: CommandMapperService,
        private readonly commandBus: CommandBus,
        private readonly queryBus: QueryBus,
    ) { }

    async route(msg: IncomingMessage): Promise<void> {
        const { from, employeeId, companyId } = msg;

        try {
            // 1. Detect type and classify intent
            const intent = await this._classifyMessage(msg);

            // 2. Load or create session, merge entities
            let session = await this.sessionRepository.getSession(from);
            if (!session) {
                session = ConversationSessionVO.create({ employeePhone: from, companyId });
            }
            const mergedEntities = {
                ...session.getCollectedEntities(),
                ...intent.getEntities(),
            };
            session = session.withIntent(intent.getIntent(), intent.getEntities());

            // 3. Map to command
            const mapResult = this.commandMapper.map(intent, employeeId, companyId, mergedEntities);

            if (mapResult.clarificationMessage) {
                // Missing fields — save session state and ask the user
                await this.sessionRepository.saveSession(session);
                this._reply(from, mapResult.clarificationMessage);
                return;
            }

            if (!mapResult.command) {
                this._reply(from, '❓ No pude entender tu solicitud. ¿Puedes reformularla?');
                return;
            }

            // 4. Execute command/query
            const result = await this._execute(mapResult.command);
            await this.sessionRepository.clearSession(from);

            // 5. Reply to user
            const reply = typeof result === 'string' ? result : '✅ Tu solicitud fue procesada correctamente.';
            this._reply(from, reply);

        } catch (err) {
            this.logger.error(`[route] Error processing message from ${from}: ${(err as Error).message}`);
            this._reply(from, '⚠️ Ocurrió un error procesando tu mensaje. Por favor inténtalo de nuevo.');
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private async _classifyMessage(msg: IncomingMessage) {
        const isAudio = msg.mimeType?.startsWith('audio/') && msg.mediaUrl;
        const isText = !!msg.body && !msg.mediaUrl;

        if (isText) {
            return this.conversationalService.processText(msg.body!);
        }

        if (isAudio) {
            return this.conversationalService.processAudio(
                msg.mediaUrl!,
                msg.mimeType!,
                msg.twilioSid,
                msg.twilioToken,
            );
        }

        // Image, document, location — not supported
        this.logger.warn(`Unsupported media type: ${msg.mimeType}`);
        return ConversationIntentVO.unknown('unsupported');
    }

    private async _execute(command: object): Promise<string | void> {
        if (command instanceof GetMyScheduleQuery) {
            return this.queryBus.execute<GetMyScheduleQuery, string>(command);
        }
        return this.commandBus.execute(command) as Promise<string | void>;
    }

    /**
     * Fire-and-forget: respond immediately without blocking the webhook handler.
     * Errors are logged but do not throw — Twilio already got its 200.
     */
    private _reply(to: string, message: string): void {
        setImmediate(() => {
            this.notificationService.sendWhatsApp(to, message).catch((err: Error) => {
                this.logger.error(`Failed to send reply to ${to}: ${err.message}`);
            });
        });
    }
}
