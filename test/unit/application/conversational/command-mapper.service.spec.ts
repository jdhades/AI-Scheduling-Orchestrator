import { Test, TestingModule } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { CommandMapperService } from '../../../../src/application/conversational/command-mapper.service';
import { ConversationIntentVO } from '../../../../src/domain/value-objects/conversation-intent.vo';
import { CreateSemanticRuleCommand } from '../../../../src/application/commands/create-semantic-rule.command';

describe('CommandMapperService', () => {
  let service: CommandMapperService;
  let i18nServiceMock: jest.Mocked<I18nService>;

  beforeEach(async () => {
    i18nServiceMock = {
      t: jest.fn().mockImplementation((key) => `translated_${key}`),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandMapperService,
        {
          provide: I18nService,
          useValue: i18nServiceMock,
        },
      ],
    }).compile();

    service = module.get<CommandMapperService>(CommandMapperService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create_rule mapping', () => {
    const employeeId = 'emp-123';
    const companyId = 'comp-456';

    it('should return missing ruleText if not provided', () => {
      const intent = ConversationIntentVO.create({
        intent: 'create_rule',
        confidence: 0.9,
        entities: {},
        rawText: 'crear regla',
      });

      const result = service.map(intent, employeeId, companyId, {});

      expect(result.command).toBeNull();
      expect(result.missingFields).toContain('ruleText');
      expect(result.clarificationMessage).toBe(
        'translated_bot.rules.missing_text',
      );
    });

    it('should map to CreateSemanticRuleCommand with NO expiration if expiresAt is null', () => {
      const intent = ConversationIntentVO.create({
        intent: 'create_rule',
        confidence: 0.9,
        entities: { ruleText: 'Test rule' },
        rawText: 'crea una regla: Test rule',
      });

      const result = service.map(intent, employeeId, companyId, {
        ruleText: 'Test rule',
      });

      expect(result.command).toBeInstanceOf(CreateSemanticRuleCommand);
      const cmd = result.command as CreateSemanticRuleCommand;
      expect(cmd.ruleText).toBe('Test rule');
      expect(cmd.expiresAt).toBeUndefined();
    });

    it('should parse ISO expiresAt injected by Gemini to end of that UTC day', () => {
      const intent = ConversationIntentVO.create({
        intent: 'create_rule',
        confidence: 0.9,
        entities: { ruleText: 'Test rule', expiresAt: '2026-04-09' },
        rawText: 'crea una regla: Test rule hasta el 9 de abril',
      });

      const result = service.map(intent, employeeId, companyId, {
        ruleText: 'Test rule',
        expiresAt: '2026-04-09',
      });

      expect(result.command).toBeInstanceOf(CreateSemanticRuleCommand);
      const cmd = result.command as CreateSemanticRuleCommand;

      expect(cmd.expiresAt).toBeDefined();
      expect(cmd.expiresAt?.toISOString()).toBe('2026-04-09T23:59:59.000Z');
    });
  });
});
