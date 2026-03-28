import { Test, TestingModule } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { CommandMapperService } from '../../../src/application/conversational/command-mapper.service';
import { ConversationIntentVO } from '../../../src/domain/value-objects/conversation-intent.vo';
import { ReportAbsenceCommand } from '../../../src/application/commands/report-absence.command';
import { RequestDayOffCommand } from '../../../src/application/commands/request-day-off.command';
import { GetMyScheduleQuery } from '../../../src/application/queries/get-my-schedule.query';
import { GenerateHybridScheduleCommand } from '../../../src/application/commands/generate-hybrid-schedule.command';

describe('CommandMapperService', () => {
  let service: CommandMapperService;

  beforeEach(async () => {
    const mockI18nService = {
      t: jest.fn().mockImplementation((key) => {
        if (key === 'bot.general.unknown_intent') return 'No entendí bien. ¿Qué necesitas?';
        if (key === 'bot.day_off.missing_date') return 'fecha';
        if (key === 'bot.absence.missing_both') return 'motivo';
        if (key === 'bot.absence.missing_shift') return 'turno';
        if (key === 'bot.absence.missing_reason') return 'motivo';
        return key;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandMapperService,
        { provide: I18nService, useValue: mockI18nService },
      ],
    }).compile();

    service = module.get<CommandMapperService>(CommandMapperService);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should handle check_schedule intent', () => {
    const intent = ConversationIntentVO.create({
      intent: 'check_schedule',
      confidence: 0.9,
      entities: {},
      rawText: 'horario',
    });

    const result = service.map(intent, 'empId', 'compId', {});

    expect(result.command).toBeInstanceOf(GetMyScheduleQuery);
    expect(result.missingFields).toEqual([]);
    expect(result.clarificationMessage).toBeNull();
  });

  describe('swap_shift', () => {
    it('should return SWAP_SELECT_SHIFT action for guided flow', () => {
      const intent = ConversationIntentVO.create({
        intent: 'swap_shift',
        confidence: 0.9,
        entities: {},
        rawText: 'cambiar turno',
      });

      const result = service.map(intent, 'empId', 'compId', {});

      expect(result.command).toBeNull();
      expect(result.actionRequired).toBe('SWAP_SELECT_SHIFT');
      expect(result.missingFields).toEqual([]);
      expect(result.clarificationMessage).toBeNull();
    });
  });

  describe('report_absence', () => {
    it('should map successfully when all entities are present', () => {
      const intent = ConversationIntentVO.create({
        intent: 'report_absence',
        confidence: 0.9,
        entities: {},
        rawText: 'no voy',
      });

      const result = service.map(intent, 'empId', 'compId', {
        shiftId: 'shift-abc',
        reason: 'enfermo',
      });

      expect(result.command).toBeInstanceOf(ReportAbsenceCommand);
      const cmd = result.command as ReportAbsenceCommand;
      expect(cmd.employeeId).toBe('empId');
      expect(cmd.shiftId).toBe('shift-abc');
      expect(cmd.reason).toBe('enfermo');
      expect(cmd.companyId).toBe('compId');
      expect(result.missingFields).toEqual([]);
    });

    it('should ask for clarification when missing reason', () => {
      const intent = ConversationIntentVO.create({
        intent: 'report_absence',
        confidence: 0.9,
        entities: {},
        rawText: 'no voy',
      });

      const result = service.map(intent, 'empId', 'compId', { shiftId: 'abc' });

      expect(result.command).toBeNull();
      expect(result.missingFields).toEqual(['reason']);
      expect(result.clarificationMessage).toContain('motivo');
    });
  });

  describe('request_day_off', () => {
    it('should map successfully when date is present', () => {
      const intent = ConversationIntentVO.create({
        intent: 'request_day_off',
        confidence: 0.9,
        entities: {},
        rawText: 'día libre',
      });

      const result = service.map(intent, 'empId', 'compId', {
        date: '2026-03-10',
        reason: 'vacaciones',
      });

      expect(result.command).toBeInstanceOf(RequestDayOffCommand);
      const cmd = result.command as RequestDayOffCommand;
      expect(cmd.employeeId).toBe('empId');
      expect(cmd.date).toBe('2026-03-10');
      expect(cmd.reason).toBe('vacaciones');
      expect(cmd.companyId).toBe('compId');
      expect(result.missingFields).toEqual([]);
    });

    it('should default reason if omitted', () => {
      const intent = ConversationIntentVO.create({
        intent: 'request_day_off',
        confidence: 0.9,
        entities: {},
        rawText: 'día libre',
      });

      const result = service.map(intent, 'empId', 'compId', {
        date: '2026-03-10',
      });

      expect(result.command).toBeInstanceOf(RequestDayOffCommand);
      expect((result.command as RequestDayOffCommand).reason).toBe(
        'No especificado',
      );
    });

    it('should ask for clarification when missing date', () => {
      const intent = ConversationIntentVO.create({
        intent: 'request_day_off',
        confidence: 0.9,
        entities: {},
        rawText: 'día libre',
      });

      const result = service.map(intent, 'empId', 'compId', {});

      expect(result.command).toBeNull();
      expect(result.missingFields).toEqual(['date']);
      expect(result.clarificationMessage).toContain('fecha');
    });
  });

  describe('generate_schedule', () => {
    it('should map to next monday when date is not specified', () => {
      // Monday is 1, next Monday will be + days
      const now = new Date('2026-03-05T12:00:00.000Z'); // Represents Thursday
      jest.setSystemTime(now);

      const intent = ConversationIntentVO.create({
        intent: 'generate_schedule',
        confidence: 0.9,
        entities: {},
        rawText: 'genera horario',
      });

      const result = service.map(intent, 'empId', 'compId', {});

      expect(result.command).toBeInstanceOf(GenerateHybridScheduleCommand);
      const cmd = result.command as GenerateHybridScheduleCommand;
      expect(cmd.companyId).toBe('compId');
      // Next Monday of 2026-03-05 (Thursday) is 2026-03-09
      expect(cmd.weekStart).toBe('2026-03-09');
      expect(result.missingFields).toEqual([]);
    });

    it('should map to specific date when specified', () => {
      const intent = ConversationIntentVO.create({
        intent: 'generate_schedule',
        confidence: 0.9,
        entities: {},
        rawText: 'genera horario',
      });

      const result = service.map(intent, 'empId', 'compId', {
        weekStart: '2026-03-16',
      });

      expect(result.command).toBeInstanceOf(GenerateHybridScheduleCommand);
      expect((result.command as GenerateHybridScheduleCommand).weekStart).toBe(
        '2026-03-16',
      );
    });
  });

  describe('unknown or low confidence intents', () => {
    it('should return clarification message for unknown intent', () => {
      const intent = ConversationIntentVO.unknown('ahhh');
      const result = service.map(intent, 'empId', 'compId', {});

      expect(result.command).toBeNull();
      expect(result.missingFields).toEqual([]);
      expect(result.clarificationMessage).toContain('No entendí bien');
      expect(result.clarificationMessage).toContain('¿Qué necesitas?');
    });

    it('should return clarification message for low confidence intent', () => {
      const intent = ConversationIntentVO.create({
        intent: 'swap_shift',
        confidence: 0.3, // action threshold is 0.6
        entities: {},
        rawText: 'turno',
      });
      const result = service.map(intent, 'empId', 'compId', {});

      expect(result.command).toBeNull();
      expect(result.missingFields).toEqual([]);
      expect(result.clarificationMessage).toContain('No entendí bien');
    });
  });
});
