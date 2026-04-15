import { Test, TestingModule } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { ReportAbsenceHandler } from '../../../src/application/handlers/report-absence.handler';
import { ReportAbsenceCommand } from '../../../src/application/commands/report-absence.command';
import { AbsenceReportedEvent } from '../../../src/domain/events/absence-reported.event';
import {
  EMPLOYEE_REPOSITORY,
  IEmployeeRepository,
} from '../../../src/domain/repositories/employee.repository';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  IShiftAssignmentRepository,
} from '../../../src/domain/repositories/shift-assignment.repository';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';
import { ShiftTemplate } from '../../../src/domain/aggregates/shift-template.aggregate';

function makeTemplate(id: string, startTime: string): ShiftTemplate {
  return {
    id,
    startTime,
    endTime: '23:00',
    companyId: 'comp-1',
  } as unknown as ShiftTemplate;
}

function makeAssignment(
  id: string,
  templateId: string,
  date: string,
  employeeId: string,
): ShiftAssignment {
  return ShiftAssignment.create({
    id,
    templateId,
    date,
    employeeId,
    companyId: 'comp-1',
    origin: 'membership',
    strategyType: 'hybrid',
    fairnessSnapshot: {},
    actualStartTime: new Date(`${date}T08:00:00Z`),
    actualEndTime: new Date(`${date}T16:00:00Z`),
  });
}

describe('ReportAbsenceHandler', () => {
  let handler: ReportAbsenceHandler;
  let mockEmployeeRepo: jest.Mocked<IEmployeeRepository>;
  let mockAssignmentRepo: jest.Mocked<IShiftAssignmentRepository>;
  let mockTemplateRepo: { findById: jest.Mock };
  let mockEventBus: jest.Mocked<EventBus>;

  beforeEach(async () => {
    mockEmployeeRepo = {
      findById: jest.fn(),
      findByPhone: jest.fn(),
      findAllByCompany: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    } as any;

    mockAssignmentRepo = {
      save: jest.fn(),
      deleteById: jest.fn(),
      deleteByDateRange: jest.fn(),
      findById: jest.fn(),
      findByEmployeeAndDateRange: jest.fn(),
      findByCompanyAndDateRange: jest.fn(),
      findBySlot: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;

    mockTemplateRepo = { findById: jest.fn() };

    mockEventBus = { publish: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportAbsenceHandler,
        { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
        { provide: SHIFT_ASSIGNMENT_REPOSITORY, useValue: mockAssignmentRepo },
        { provide: 'SHIFT_TEMPLATE_REPOSITORY', useValue: mockTemplateRepo },
        { provide: EventBus, useValue: mockEventBus },
      ],
    }).compile();

    handler = module.get<ReportAbsenceHandler>(ReportAbsenceHandler);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('emits AbsenceReportedEvent (not urgent) when shift starts >2h away', async () => {
    jest.setSystemTime(new Date('2026-03-05T12:00:00Z'));

    const requester = { id: 'req-1' } as Employee;
    const assignment = makeAssignment('a1', 'tpl-1', '2026-03-05', 'req-1');

    mockEmployeeRepo.findById.mockResolvedValue(requester);
    mockAssignmentRepo.findById.mockResolvedValue(assignment);
    mockTemplateRepo.findById.mockResolvedValue(makeTemplate('tpl-1', '16:00'));

    await handler.execute(
      new ReportAbsenceCommand('req-1', 'a1', 'Sick', 'comp-1'),
    );

    expect(mockAssignmentRepo.deleteById).toHaveBeenCalledWith('a1', 'comp-1');
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.any(AbsenceReportedEvent),
    );
    const event = mockEventBus.publish.mock.calls[0][0] as AbsenceReportedEvent;
    expect(event.employeeId).toBe('req-1');
    expect(event.shiftId).toBe('a1');
    expect(event.reason).toBe('Sick');
    expect(event.isUrgent).toBe(false);
  });

  it('flags as urgent when the shift starts <2h away', async () => {
    jest.setSystemTime(new Date('2026-03-05T12:00:00Z'));

    const requester = { id: 'req-1' } as Employee;
    const assignment = makeAssignment('a2', 'tpl-1', '2026-03-05', 'req-1');

    mockEmployeeRepo.findById.mockResolvedValue(requester);
    mockAssignmentRepo.findById.mockResolvedValue(assignment);
    mockTemplateRepo.findById.mockResolvedValue(makeTemplate('tpl-1', '13:00'));

    await handler.execute(
      new ReportAbsenceCommand('req-1', 'a2', 'Car breakdown', 'comp-1'),
    );

    const event = mockEventBus.publish.mock.calls[0][0] as AbsenceReportedEvent;
    expect(event.isUrgent).toBe(true);
  });

  it('throws when the employee is not found', async () => {
    mockEmployeeRepo.findById.mockResolvedValue(null);
    await expect(
      handler.execute(new ReportAbsenceCommand('bad', 'a1', 'Sick', 'comp-1')),
    ).rejects.toThrow('Employee not found');
  });

  it('throws when assignment does not belong to employee', async () => {
    mockEmployeeRepo.findById.mockResolvedValue({ id: 'req-1' } as Employee);
    mockAssignmentRepo.findById.mockResolvedValue(
      makeAssignment('a3', 'tpl-1', '2026-03-05', 'other-emp'),
    );
    await expect(
      handler.execute(new ReportAbsenceCommand('req-1', 'a3', 'Sick', 'comp-1')),
    ).rejects.toThrow('Assignment a3 is not assigned to employee req-1');
  });
});
