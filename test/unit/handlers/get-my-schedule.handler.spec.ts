import { Test, TestingModule } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { GetMyScheduleHandler } from '../../../src/application/handlers/get-my-schedule.handler';
import { GetMyScheduleQuery } from '../../../src/application/queries/get-my-schedule.query';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  IShiftAssignmentRepository,
} from '../../../src/domain/repositories/shift-assignment.repository';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';
import type { ShiftTemplate } from '../../../src/domain/aggregates/shift-template.aggregate';

function makeAssignment(
  id: string,
  templateId: string,
  date: string,
): ShiftAssignment {
  return ShiftAssignment.create({
    id,
    templateId,
    date,
    employeeId: 'emp-1',
    companyId: 'comp-1',
    origin: 'membership',
    strategyType: 'hybrid',
    fairnessSnapshot: {},
    actualStartTime: new Date(`${date}T08:00:00Z`),
    actualEndTime: new Date(`${date}T16:00:00Z`),
  });
}

function makeTemplate(
  id: string,
  startTime: string,
  endTime: string,
): ShiftTemplate {
  return { id, startTime, endTime } as unknown as ShiftTemplate;
}

describe('GetMyScheduleHandler', () => {
  let handler: GetMyScheduleHandler;
  let mockRepo: jest.Mocked<IShiftAssignmentRepository>;
  let mockTemplateRepo: { findById: jest.Mock };

  beforeEach(async () => {
    mockRepo = {
      save: jest.fn(),
      deleteById: jest.fn(),
      deleteByDateRange: jest.fn(),
      findById: jest.fn(),
      findByEmployeeAndDateRange: jest.fn().mockResolvedValue([]),
      findByCompanyAndDateRange: jest.fn(),
      findBySlot: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;
    mockTemplateRepo = { findById: jest.fn() };

    const mockI18nService = {
      t: jest.fn().mockImplementation((key) => {
        if (key === 'bot.schedule.none_this_week')
          return '📅 No tienes turnos asignados esta semana.';
        if (key === 'bot.schedule.title_that_week')
          return '📅 *Tu horario para la semana del';
        if (key === 'bot.schedule.anything_else') return '¿Necesitas algo más?';
        return key;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetMyScheduleHandler,
        { provide: SHIFT_ASSIGNMENT_REPOSITORY, useValue: mockRepo },
        { provide: 'SHIFT_TEMPLATE_REPOSITORY', useValue: mockTemplateRepo },
        { provide: I18nService, useValue: mockI18nService },
      ],
    }).compile();

    handler = module.get(GetMyScheduleHandler);

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-02T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a fallback message when employee has no assignments', async () => {
    mockRepo.findByEmployeeAndDateRange.mockResolvedValue([]);

    const result = await handler.execute(
      new GetMyScheduleQuery('emp-1', 'comp-1'),
    );

    expect(result).toBe('📅 No tienes turnos asignados esta semana.');
    expect(mockRepo.findByEmployeeAndDateRange).toHaveBeenCalledWith(
      'emp-1',
      'comp-1',
      expect.any(String),
      expect.any(String),
    );
  });

  it('formats the schedule combining template times with the assignment date', async () => {
    const a1 = makeAssignment('a1', 'tpl-day', '2026-03-02');
    const a2 = makeAssignment('a2', 'tpl-late', '2026-03-03');

    mockRepo.findByEmployeeAndDateRange.mockResolvedValue([a1, a2]);
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'tpl-day') return makeTemplate('tpl-day', '08:00', '16:00');
      if (id === 'tpl-late') return makeTemplate('tpl-late', '10:00', '18:00');
      return null;
    });

    const result = await handler.execute(
      new GetMyScheduleQuery('emp-1', 'comp-1', '2026-03-02'),
    );

    expect(result).toContain('📅 *Tu horario para la semana del');
    expect(result).toContain('(ID: a1');
    expect(result).toContain('(ID: a2');
    expect(result).toContain('¿Necesitas algo más?');
  });

  it('queries for the current ISO week when weekStart is omitted', async () => {
    mockRepo.findByEmployeeAndDateRange.mockResolvedValue([]);

    await handler.execute(new GetMyScheduleQuery('emp-1', 'comp-1'));

    const [empId, companyId, from, to] =
      mockRepo.findByEmployeeAndDateRange.mock.calls[0];
    expect(empId).toBe('emp-1');
    expect(companyId).toBe('comp-1');
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
