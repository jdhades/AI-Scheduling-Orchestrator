import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GeminiConversationalService } from '../../../../src/infrastructure/conversational/gemini-conversational.service';
import { IntentType } from '../../../../src/domain/value-objects/conversation-intent.vo';

describe('GeminiConversationalService', () => {
  let service: GeminiConversationalService;
  let configService: ConfigService;

  // We mock the global fetch API
  let globalFetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeminiConversationalService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-api-key'),
          },
        },
      ],
    }).compile();

    service = module.get<GeminiConversationalService>(
      GeminiConversationalService,
    );
    configService = module.get<ConfigService>(ConfigService);

    globalFetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('processText()', () => {
    it('should correctly parse a valid JSON response from Gemini', async () => {
      const mockJsonResponse = {
        intent: 'swap_shift',
        confidence: 0.95,
        entities: { targetEmployeePhone: '+1234567890', shiftId: 'shift-1' },
      };

      globalFetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: `\`\`\`json\n${JSON.stringify(mockJsonResponse)}\n\`\`\``,
                  },
                ],
              },
            },
          ],
        }),
      });

      const result = await service.processText(
        'I want to swap my shift with +1234567890',
      );

      expect(result.getIntent()).toBe('swap_shift');
      expect(result.getConfidence()).toBe(0.95);
      expect(result.getEntities()).toEqual({
        targetEmployeePhone: '+1234567890',
        shiftId: 'shift-1',
      });
      expect(result.getRawText()).toBe(
        'I want to swap my shift with +1234567890',
      );
      expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should return unknown intent if JSON is malformed', async () => {
      globalFetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'This is not valid JSON' }],
              },
            },
          ],
        }),
      });

      const result = await service.processText('Help me');

      expect(result.getIntent()).toBe('unknown');
      expect(result.getConfidence()).toBe(0);
      expect(result.isUnknown()).toBe(true);
      expect(result.getRawText()).toBe('Help me');
    });

    it('should handle missing entities and return empty object for them', async () => {
      const mockJsonResponse = {
        intent: 'check_schedule',
        confidence: 0.8,
      };

      globalFetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(mockJsonResponse) }],
              },
            },
          ],
        }),
      });

      const result = await service.processText('When do I work?');

      expect(result.getIntent()).toBe('check_schedule');
      expect(result.getEntities()).toEqual({});
    });

    it('should return unknown intent on network failure/timeout', async () => {
      globalFetchSpy.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.processText('Timeout message');

      expect(result.getIntent()).toBe('unknown');
      expect(result.getConfidence()).toBe(0);
      expect(result.getRawText()).toBe('Timeout message');
    });
  });

  describe('processAudio()', () => {
    beforeEach(() => {
      // Mock the audio download from Twilio
      globalFetchSpy.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8), // Dummy audio byte array
      });
    });

    it('should correctly process audio, convert to base64, and parse the valid JSON intent from Gemini', async () => {
      const mockJsonResponse = {
        intent: 'report_absence',
        confidence: 0.99,
        entities: { reason: 'I am sick' },
        transcription: 'I am sick and cannot come to work.',
      };

      // Second fetch call is for Gemini API
      globalFetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(mockJsonResponse) }],
              },
            },
          ],
        }),
      });

      const result = await service.processAudio(
        'https://api.twilio.com/audio.mp3',
        'audio/mp3',
        'twilio-sid',
        'twilio-token',
      );

      expect(globalFetchSpy).toHaveBeenCalledTimes(2);

      // Audio download from Twilio
      expect(globalFetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://api.twilio.com/audio.mp3',
        expect.objectContaining({
          headers: { Authorization: expect.stringContaining('Basic ') },
        }),
      );

      // Gemini call
      expect(globalFetchSpy).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('gemini-2.5-flash'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('inlineData'),
        }),
      );

      expect(result.getIntent()).toBe('report_absence');
      expect(result.getConfidence()).toBe(0.99);
      expect(result.getRawText()).toBe('I am sick and cannot come to work.');
      expect(result.getEntities()).toEqual({ reason: 'I am sick' });
    });

    it('should return unknown if Twilio audio download fails', async () => {
      jest.restoreAllMocks();
      globalFetchSpy = jest.spyOn(global, 'fetch');
      // Mock Twilio failing
      globalFetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await service.processAudio(
        'http://bad-url',
        'audio/mp3',
        'sid',
        'token',
      );

      expect(result.getIntent()).toBe('unknown');
      expect(globalFetchSpy).toHaveBeenCalledTimes(1); // Didn't proceed to call Gemini
    });
  });
});
