import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { MessageRouterService, IncomingMessage } from '../../../src/application/conversational/message-router.service';
import { CONVERSATIONAL_SERVICE, IConversationalService } from '../../../src/domain/services/conversational.service.interface';
import { NOTIFICATION_SERVICE, INotificationService } from '../../../src/domain/services/notification.service';
import { ConversationSessionRepository } from '../../../src/infrastructure/conversational/conversation-session.repository';
import { CommandMapperService } from '../../../src/application/conversational/command-mapper.service';
import { ConversationIntentVO } from '../../../src/domain/value-objects/conversation-intent.vo';
import { ConversationSessionVO } from '../../../src/domain/value-objects/conversation-session.vo';
import { SwapShiftCommand } from '../../../src/application/commands/swap-shift.command';
import { GetMyScheduleQuery } from '../../../src/application/queries/get-my-schedule.query';

describe('MessageRouterService', () => {
    let service: MessageRouterService;
    let mockConversationalService: jest.Mocked<IConversationalService>;
    let mockNotificationService: jest.Mocked<INotificationService>;
    let mockSessionRepository: jest.Mocked<ConversationSessionRepository>;
    let mockCommandMapper: jest.Mocked<CommandMapperService>;
    let mockCommandBus: jest.Mocked<CommandBus>;
    let mockQueryBus: jest.Mocked<QueryBus>;

    beforeEach(async () => {
        mockConversationalService = {
            processText: jest.fn(),
            processAudio: jest.fn(),
        } as any;

        mockNotificationService = {
            sendWhatsApp: jest.fn().mockResolvedValue(true),
        } as any;

        mockSessionRepository = {
            getSession: jest.fn(),
            saveSession: jest.fn(),
            clearSession: jest.fn(),
        } as any;

        mockCommandMapper = {
            map: jest.fn(),
        } as any;

        mockCommandBus = {
            execute: jest.fn(),
        } as any;

        mockQueryBus = {
            execute: jest.fn(),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                MessageRouterService,
                { provide: CONVERSATIONAL_SERVICE, useValue: mockConversationalService },
                { provide: NOTIFICATION_SERVICE, useValue: mockNotificationService },
                { provide: ConversationSessionRepository, useValue: mockSessionRepository },
                { provide: CommandMapperService, useValue: mockCommandMapper },
                { provide: CommandBus, useValue: mockCommandBus },
                { provide: QueryBus, useValue: mockQueryBus },
            ],
        }).compile();

        service = module.get<MessageRouterService>(MessageRouterService);
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Helper to flush promises so we can test setImmediate in `_reply`

    describe('route()', () => {
        it('should correctly process a text message and execute a command', async () => {
            const msg: IncomingMessage = {
                from: '+1234567890',
                companyId: 'comp',
                employeeId: 'emp',
                body: 'test text',
                twilioSid: '',
                twilioToken: ''
            };

            const mockIntent = ConversationIntentVO.create({
                intent: 'swap_shift',
                confidence: 0.9,
                entities: {},
                rawText: 'test text'
            });

            mockConversationalService.processText.mockResolvedValueOnce(mockIntent);
            mockSessionRepository.getSession.mockResolvedValueOnce(null);

            const command = new SwapShiftCommand('emp', '+098', 'shift-1', 'comp');
            mockCommandMapper.map.mockReturnValueOnce({
                command,
                missingFields: [],
                clarificationMessage: null,
            });

            await service.route(msg);

            expect(mockConversationalService.processText).toHaveBeenCalledWith('test text');
            expect(mockCommandBus.execute).toHaveBeenCalledWith(command);
            expect(mockSessionRepository.clearSession).toHaveBeenCalledWith('+1234567890');

            jest.runAllTimers();
            await Promise.resolve();
            expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith('+1234567890', '✅ Tu solicitud fue procesada correctamente.');
        });

        it('should correctly process an audio message and execute a query', async () => {
            const msg: IncomingMessage = {
                from: '+1234567890',
                companyId: 'comp',
                employeeId: 'emp',
                mediaUrl: 'http://audio',
                mimeType: 'audio/mp3',
                twilioSid: 'sid',
                twilioToken: 'token'
            };

            const mockIntent = ConversationIntentVO.create({
                intent: 'check_schedule',
                confidence: 0.9,
                entities: {},
                rawText: 'test audio text'
            });

            mockConversationalService.processAudio.mockResolvedValueOnce(mockIntent);
            mockSessionRepository.getSession.mockResolvedValueOnce(null);

            const query = new GetMyScheduleQuery('emp', 'comp');
            mockCommandMapper.map.mockReturnValueOnce({
                command: query,
                missingFields: [],
                clarificationMessage: null,
            });

            mockQueryBus.execute.mockResolvedValueOnce('Your schedule is XYZ');

            await service.route(msg);

            expect(mockConversationalService.processAudio).toHaveBeenCalledWith('http://audio', 'audio/mp3', 'sid', 'token');
            expect(mockQueryBus.execute).toHaveBeenCalledWith(query);

            jest.runAllTimers();
            await Promise.resolve();
            expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith('+1234567890', 'Your schedule is XYZ');
        });

        it('should handle unsupported media types gracefully', async () => {
            const msg: IncomingMessage = {
                from: '+1234567890',
                companyId: 'comp',
                employeeId: 'emp',
                mediaUrl: 'http://image',
                mimeType: 'image/png',
                twilioSid: '',
                twilioToken: ''
            };

            mockSessionRepository.getSession.mockResolvedValueOnce(null);

            mockCommandMapper.map.mockReturnValueOnce({
                command: null,
                missingFields: [],
                clarificationMessage: null,
            });

            await service.route(msg);

            // Never calls Gemini
            expect(mockConversationalService.processText).not.toHaveBeenCalled();
            expect(mockConversationalService.processAudio).not.toHaveBeenCalled();

            jest.runAllTimers();
            await Promise.resolve();
            expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith('+1234567890', '❓ No pude entender tu solicitud. ¿Puedes reformularla?');
        });

        it('should ask for clarification and save session when fields are missing', async () => {
            const msg: IncomingMessage = {
                from: '+1234567890', companyId: 'comp', employeeId: 'emp', body: 'swap', twilioSid: '', twilioToken: ''
            };

            const mockIntent = ConversationIntentVO.create({
                intent: 'swap_shift',
                confidence: 0.9,
                entities: {},
                rawText: 'swap'
            });

            // Return a new mock session so it behaves like it was loaded but needs more
            const mockSession = ConversationSessionVO.create({ employeePhone: '+1234567890', companyId: 'comp' });

            mockConversationalService.processText.mockResolvedValueOnce(mockIntent);
            mockSessionRepository.getSession.mockResolvedValueOnce(mockSession);

            mockCommandMapper.map.mockReturnValueOnce({
                command: null,
                missingFields: ['shiftId'],
                clarificationMessage: 'What is the shift id?',
            });

            await service.route(msg);

            // Execution was not called
            expect(mockCommandBus.execute).not.toHaveBeenCalled();

            // Session was saved instead of cleared
            expect(mockSessionRepository.saveSession).toHaveBeenCalled();

            jest.runAllTimers();
            await Promise.resolve();
            expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith('+1234567890', 'What is the shift id?');
        });
    });
});
