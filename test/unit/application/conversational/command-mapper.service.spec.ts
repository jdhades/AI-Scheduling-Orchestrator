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
      expect(result.clarificationMessage).toBe('translated_bot.rules.missing_text');
    });

    it('should map to CreateSemanticRuleCommand with NO expiration if durationStr is null', () => {
      const intent = ConversationIntentVO.create({
        intent: 'create_rule',
        confidence: 0.9,
        entities: { ruleText: 'Test rule' },
        rawText: 'crea una regla: Test rule',
      });

      const result = service.map(intent, employeeId, companyId, {
        ruleText: 'Test rule', // merged entities
      });

      expect(result.command).toBeInstanceOf(CreateSemanticRuleCommand);
      const cmd = result.command as CreateSemanticRuleCommand;
      expect(cmd.ruleText).toBe('Test rule');
      expect(cmd.expiresAt).toBeUndefined();
    });

    it('should parse durationStr "por un mes" to a future date approximately 1 month away', () => {
      const intent = ConversationIntentVO.create({
        intent: 'create_rule',
        confidence: 0.9,
        entities: { ruleText: 'Test rule', durationStr: 'por un mes' },
        rawText: 'crea una regla: Test rule por un mes',
      });

      const result = service.map(intent, employeeId, companyId, {
        ruleText: 'Test rule',
        durationStr: 'por un mes',
      });

      expect(result.command).toBeInstanceOf(CreateSemanticRuleCommand);
      const cmd = result.command as CreateSemanticRuleCommand;
      
      expect(cmd.expiresAt).toBeDefined();
      const expires = cmd.expiresAt!;
      
      // Calculate approximately 1 month from now
      const expected = new Date();
      expected.setMonth(expected.getMonth() + 1);
      
      // Should be roughly the same day/month target
      expect(expires.getMonth()).toEqual(expected.getMonth());
      expect(expires.getFullYear()).toEqual(expected.getFullYear());
    });

    it('should parse durationStr "esta semana" to a future date 7 days away', () => {
      const result = service.map(
        ConversationIntentVO.create({
          intent: 'create_rule',
          confidence: 0.9,
          entities: { ruleText: 'rule', durationStr: 'esta semana' },
          rawText: 'text',
        }),
        employeeId,
        companyId,
        { ruleText: 'rule', durationStr: 'esta semana' },
      );

      const cmd = result.command as CreateSemanticRuleCommand;
      expect(cmd.expiresAt).toBeDefined();
      
      const expected = new Date();
      expected.setDate(expected.getDate() + 7);
      
      expect(cmd.expiresAt!.getDate()).toEqual(expected.getDate());
    });

    it('should parse durationStr "hoy" to end of current day', () => {
      const result = service.map(
        ConversationIntentVO.create({
          intent: 'create_rule',
          confidence: 0.9,
          entities: { ruleText: 'rule', durationStr: 'solo hoy' },
          rawText: 'text',
        }),
        employeeId,
        companyId,
        { ruleText: 'rule', durationStr: 'solo hoy' },
      );

      const cmd = result.command as CreateSemanticRuleCommand;
      expect(cmd.expiresAt).toBeDefined();
      
      const expected = new Date();
      expected.setHours(23, 59, 59, 999);
      
      expect(cmd.expiresAt!.getTime()).toEqual(expected.getTime());
    });
    
    it('should parse durationStr "mañana" to end of tomorrow', () => {
      const result = service.map(
        ConversationIntentVO.create({
          intent: 'create_rule',
          confidence: 0.9,
          entities: { ruleText: 'rule', durationStr: 'hasta mañana' },
          rawText: 'text',
        }),
        employeeId,
        companyId,
        { ruleText: 'rule', durationStr: 'hasta mañana' },
      );

      const cmd = result.command as CreateSemanticRuleCommand;
      expect(cmd.expiresAt).toBeDefined();
      
      const expected = new Date();
      expected.setDate(expected.getDate() + 1);
      expected.setHours(23, 59, 59, 999);
      
      expect(cmd.expiresAt!.getTime()).toEqual(expected.getTime());
    });
  });
});
