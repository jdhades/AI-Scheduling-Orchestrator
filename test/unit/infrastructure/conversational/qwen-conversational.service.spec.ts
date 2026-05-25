import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { QwenConversationalService } from '../../../../src/infrastructure/conversational/qwen-conversational.service';
import { LLMUsageLogger } from '../../../../src/infrastructure/observability/llm-usage-logger.service';
import { ConversationIntentVO } from '../../../../src/domain/value-objects/conversation-intent.vo';

describe('QwenConversationalService', () => {
  let service: QwenConversationalService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QwenConversationalService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('fake-qwen-key'),
          },
        },
        {
          provide: LLMUsageLogger,
          useValue: {
            // Stub: el servicio loguea uso async; en tests no nos importa
            // qué loguea, solo que no rompa por dep ausente.
            logUsage: jest.fn().mockResolvedValue(undefined),
            logFailure: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<QwenConversationalService>(QwenConversationalService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processText', () => {
    it('should parse valid Qwen extraction correctly', async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'swap_shift',
                confidence: 0.95,
                entities: { date: '2025-10-10' },
                transcription: null,
              }),
            },
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockApiResponse,
      });

      const text = 'quiero cambiar mi turno del 10 de octubre';
      const result = await service.processText(text);

      expect(result).toBeInstanceOf(ConversationIntentVO);
      expect(result.getIntent()).toBe('swap_shift');
      expect(result.getConfidence()).toBe(0.95);
      expect(result.getEntities().date).toBe('2025-10-10');
    });

    it('should handle 429 rate limits natively and return systemUnavailable', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      // Bypasses the delays automatically thanks to jest mocks optionally,
      // but might wait slightly. We'll add fake timers if needed later.
      const text = 'cambia mi turno';
      jest.spyOn(service as any, '_delay').mockResolvedValue(undefined); // bypass timeout waits

      const result = await service.processText(text);
      expect(result.getIntent()).toBe('system_unavailable');
    });

    it('should handle invalid JSON from Qwen safely', async () => {
      const mockApiResponse = {
        choices: [
          {
            message: {
              content: '{ invalid json ]',
            },
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockApiResponse,
      });

      const result = await service.processText('test');
      expect(result.getIntent()).toBe('unknown');
    });
  });
});
