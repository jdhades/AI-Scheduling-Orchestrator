import { Test, TestingModule } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  MessageRouterService,
  IncomingMessage,
} from '../../../src/application/conversational/message-router.service';
import {
  CONVERSATIONAL_SERVICE,
  IConversationalService,
} from '../../../src/domain/services/conversational.service.interface';
import {
  NOTIFICATION_SERVICE,
  INotificationService,
} from '../../../src/domain/services/notification.service';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  IShiftAssignmentRepository,
} from '../../../src/domain/repositories/shift-assignment.repository';
import {
  EMPLOYEE_REPOSITORY,
  IEmployeeRepository,
} from '../../../src/domain/repositories/employee.repository';
import { ShiftSlotGeneratorService } from '../../../src/domain/services/shift-slot-generator.service';
import { ConversationSessionRepository } from '../../../src/infrastructure/conversational/conversation-session.repository';
import { CommandMapperService } from '../../../src/application/conversational/command-mapper.service';
import { ConversationIntentVO } from '../../../src/domain/value-objects/conversation-intent.vo';
import { ConversationSessionVO } from '../../../src/domain/value-objects/conversation-session.vo';
import { ReportAbsenceCommand } from '../../../src/application/commands/report-absence.command';
import { GetMyScheduleQuery } from '../../../src/application/queries/get-my-schedule.query';
import { WHATSAPP_PENDING_CLARIFICATION_REPOSITORY } from '../../../src/domain/repositories/whatsapp-pending-clarification.repository';
import { WhatsappPolicyPermissionService } from '../../../src/domain/services/whatsapp-policy-permission.service';
import { CompanyPolicyCreator } from '../../../src/domain/services/company-policy-creator.service';
import { PolicyScopeResolver } from '../../../src/application/conversational/policy-scope-resolver.service';
import { LLMUsageTracker } from '../../../src/infrastructure/observability/llm-usage-tracker.service';

describe('MessageRouterService', () => {
  let service: MessageRouterService;
  let mockConversationalService: jest.Mocked<IConversationalService>;
  let mockNotificationService: jest.Mocked<INotificationService>;
  let mockSessionRepository: jest.Mocked<ConversationSessionRepository>;
  let mockCommandMapper: jest.Mocked<CommandMapperService>;
  let mockCommandBus: jest.Mocked<CommandBus>;
  let mockQueryBus: jest.Mocked<QueryBus>;
  let mockAssignmentRepo: jest.Mocked<IShiftAssignmentRepository>;
  let mockEmployeeRepo: jest.Mocked<IEmployeeRepository>;
  let mockShiftTemplateRepo: any;
  let mockSlotGenerator: jest.Mocked<ShiftSlotGeneratorService>;

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

    mockAssignmentRepo = {
      save: jest.fn(),
      deleteById: jest.fn(),
      deleteByDateRange: jest.fn(),
      findById: jest.fn(),
      findByEmployeeAndDateRange: jest.fn(),
      findByCompanyAndDateRange: jest.fn().mockResolvedValue([]),
      findBySlot: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;

    mockSlotGenerator = {
      generateSlotsForWeek: jest.fn().mockReturnValue([]),
    } as any;

    mockEmployeeRepo = {
      findById: jest.fn(),
      findByPhone: jest.fn(),
      findAllByCompany: jest.fn(),
      save: jest.fn(),
      markWhatsappVerified: jest.fn(),
    } as any;

    mockShiftTemplateRepo = {
      findAllByCompany: jest.fn(),
    } as any;

    const mockI18nService = {
      t: jest.fn().mockImplementation((key) => {
        if (key === 'bot.general.success') return '✅ Tu solicitud fue procesada correctamente.';
        if (key === 'bot.general.clarification') return '❓ No pude entender tu solicitud. ¿Puedes reformularla?';
        if (key === 'bot.swap.select_own_shift') return 'Intercambio de turno';
        return key;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageRouterService,
        {
          provide: CONVERSATIONAL_SERVICE,
          useValue: mockConversationalService,
        },
        { provide: NOTIFICATION_SERVICE, useValue: mockNotificationService },
        { provide: SHIFT_ASSIGNMENT_REPOSITORY, useValue: mockAssignmentRepo },
        { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
        { provide: ShiftSlotGeneratorService, useValue: mockSlotGenerator },
        {
          provide: ConversationSessionRepository,
          useValue: mockSessionRepository,
        },
        { provide: CommandMapperService, useValue: mockCommandMapper },
        { provide: CommandBus, useValue: mockCommandBus },
        { provide: QueryBus, useValue: mockQueryBus },
        { provide: I18nService, useValue: mockI18nService },
        { provide: 'SHIFT_TEMPLATE_REPOSITORY', useValue: mockShiftTemplateRepo },
        { provide: 'SUPABASE_CLIENT', useValue: { from: jest.fn().mockReturnThis(), select: jest.fn().mockReturnValue({ data: [], error: null }) } },
        // Suggestion-loop por WhatsApp (commit 9 follow-up): mocks que no
        // disparan el flow (canCreatePolicy=false bloquea el camino de
        // create_rule, findActiveByEmployee=null evita branchear al
        // clarification handler). Tests específicos del suggestion-loop
        // van en su propio archivo.
        {
          provide: WHATSAPP_PENDING_CLARIFICATION_REPOSITORY,
          useValue: {
            save: jest.fn(),
            findActiveByEmployee: jest.fn().mockResolvedValue(null),
            findById: jest.fn(),
            markResolved: jest.fn(),
          },
        },
        {
          provide: WhatsappPolicyPermissionService,
          useValue: {
            canCreatePolicy: jest.fn().mockResolvedValue(false),
            getAllowedRoles: jest.fn().mockResolvedValue(['manager']),
          },
        },
        {
          provide: CompanyPolicyCreator,
          useValue: {
            create: jest.fn().mockResolvedValue({
              status: 'created',
              mode: 'matched',
              policy: { getText: () => 'mock policy' },
            }),
          },
        },
        {
          provide: PolicyScopeResolver,
          useValue: {
            resolve: jest.fn().mockResolvedValue({
              scope: { type: 'company', id: null },
              targetName: null,
            }),
          },
        },
        {
          provide: LLMUsageTracker,
          useValue: {
            run: jest.fn().mockImplementation(async (fn: any) => {
              const result = await fn();
              return {
                result,
                usage: { calls: 0, prompt: 0, completion: 0, total: 0 },
              };
            }),
            record: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MessageRouterService>(MessageRouterService);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('route()', () => {
    it('should correctly process a text message and execute a command', async () => {
      const msg: IncomingMessage = {
        from: '+1234567890',
        companyId: 'comp',
        employeeId: 'emp',
        body: 'reportar ausencia turno shift-1 motivo enfermo',
        twilioSid: '',
        twilioToken: '',
      };

      const mockIntent = ConversationIntentVO.create({
        intent: 'report_absence',
        confidence: 0.9,
        entities: {},
        rawText: 'reportar ausencia',
      });

      mockConversationalService.processText.mockResolvedValueOnce(mockIntent);
      mockSessionRepository.getSession.mockResolvedValueOnce(null);

      const commandMapped = new ReportAbsenceCommand('emp', 'shift-1', 'enfermo', 'comp');
      mockCommandMapper.map.mockReturnValueOnce({
        command: commandMapped,
        missingFields: [],
        clarificationMessage: null,
      });

      mockAssignmentRepo.resolveShortId.mockResolvedValueOnce('550e8400-e29b-41d4-a716-446655440000');
      const expectedCommandToExecute = new ReportAbsenceCommand('emp', '550e8400-e29b-41d4-a716-446655440000', 'enfermo', 'comp');

      await service.route(msg);

      expect(mockConversationalService.processText).toHaveBeenCalled();
      expect(mockCommandBus.execute).toHaveBeenCalledWith(expectedCommandToExecute);
      expect(mockSessionRepository.clearSession).toHaveBeenCalledWith(
        '+1234567890',
      );

      jest.runAllTimers();
      await Promise.resolve();
      expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
        '+1234567890',
        '✅ Tu solicitud fue procesada correctamente.',
      );
    });

    it('should correctly process an audio message and execute a query', async () => {
      const msg: IncomingMessage = {
        from: '+1234567890',
        companyId: 'comp',
        employeeId: 'emp',
        mediaUrl: 'http://audio',
        mimeType: 'audio/mp3',
        twilioSid: 'sid',
        twilioToken: 'token',
      };

      const mockIntent = ConversationIntentVO.create({
        intent: 'check_schedule',
        confidence: 0.9,
        entities: {},
        rawText: 'test audio text',
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

      expect(mockConversationalService.processAudio).toHaveBeenCalledWith(
        'http://audio',
        'audio/mp3',
        'sid',
        'token',
      );
      expect(mockQueryBus.execute).toHaveBeenCalledWith(query);

      jest.runAllTimers();
      await Promise.resolve();
      expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
        '+1234567890',
        'Your schedule is XYZ',
      );
    });

    it('should handle unsupported media types gracefully', async () => {
      const msg: IncomingMessage = {
        from: '+1234567890',
        companyId: 'comp',
        employeeId: 'emp',
        mediaUrl: 'http://image',
        mimeType: 'image/png',
        twilioSid: '',
        twilioToken: '',
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
      expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
        '+1234567890',
        '❓ No pude entender tu solicitud. ¿Puedes reformularla?',
      );
    });

    it('should start swap flow when SWAP_SELECT_SHIFT action is returned', async () => {
      const msg: IncomingMessage = {
        from: '+1234567890',
        companyId: 'comp',
        employeeId: 'emp',
        body: 'intercambiar turno',
        twilioSid: '',
        twilioToken: '',
      };

      const mockIntent = ConversationIntentVO.create({
        intent: 'swap_shift',
        confidence: 0.9,
        entities: {},
        rawText: 'intercambiar turno',
      });

      mockConversationalService.processText.mockResolvedValueOnce(mockIntent);
      mockSessionRepository.getSession.mockResolvedValueOnce(null);

      mockCommandMapper.map.mockReturnValueOnce({
        command: null,
        missingFields: [],
        clarificationMessage: null,
        actionRequired: 'SWAP_SELECT_SHIFT',
      });

      // Return some upcoming shifts
      mockQueryBus.execute.mockResolvedValueOnce([
        {
          shiftId: 'shift-1',
          startTime: new Date('2026-03-28T10:00:00Z'),
          endTime: new Date('2026-03-28T18:00:00Z'),
        },
      ]);

      await service.route(msg);

      // Session should be saved with swap state
      expect(mockSessionRepository.saveSession).toHaveBeenCalled();

      // Should NOT execute any command
      expect(mockCommandBus.execute).not.toHaveBeenCalled();

      jest.runAllTimers();
      await Promise.resolve();
      expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
        '+1234567890',
        expect.stringContaining('Intercambio de turno'),
      );
    });

    it('should ask for clarification and save session when fields are missing', async () => {
      const msg: IncomingMessage = {
        from: '+1234567890',
        companyId: 'comp',
        employeeId: 'emp',
        body: 'ausencia',
        twilioSid: '',
        twilioToken: '',
      };

      const mockIntent = ConversationIntentVO.create({
        intent: 'report_absence',
        confidence: 0.9,
        entities: {},
        rawText: 'ausencia',
      });

      const mockSession = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'comp',
      });

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
      expect(mockNotificationService.sendWhatsApp).toHaveBeenCalledWith(
        '+1234567890',
        'What is the shift id?',
      );
    });
  });
});
