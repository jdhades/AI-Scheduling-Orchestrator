import { Test, TestingModule } from '@nestjs/testing';
import { ReportAbsenceHandler } from '../../../src/application/handlers/report-absence.handler';
import { ReportAbsenceCommand } from '../../../src/application/commands/report-absence.command';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../../src/domain/repositories/shift-assignment.repository';
import { AbsenceReportCreator } from '../../../src/domain/services/absence-report-creator.service';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';

/**
 * Tests del handler post-Phase 17.2: el handler delega TODA la lógica
 * (deletes + isUrgent + event publish) en AbsenceReportCreator.create().
 * Acá verificamos solo el contrato del adapter:
 *   1. Lookup del assignment puntual.
 *   2. Guard que el assignment pertenezca al empleado del command.
 *   3. Llamada al creator con los args derivados (startDate=endDate=date
 *      del assignment, assignmentIdHint=id).
 *
 * Los tests de isUrgent / event publishing / side-effects son de
 * AbsenceReportCreator y van en su propio spec.
 */

function makeAssignment(
  id: string,
  date: string,
  employeeId: string,
): ShiftAssignment {
  return ShiftAssignment.create({
    id,
    templateId: 'tpl-1',
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
  let mockAssignmentRepo: jest.Mocked<IShiftAssignmentRepository>;
  let mockCreator: jest.Mocked<AbsenceReportCreator>;

  beforeEach(async () => {
    mockAssignmentRepo = {
      save: jest.fn(),
      deleteById: jest.fn(),
      deleteByIdsBatch: jest.fn().mockResolvedValue([]),
      deleteByDateRange: jest.fn(),
      findById: jest.fn(),
      findByEmployeeAndDateRange: jest.fn(),
      findByCompanyAndDateRange: jest.fn(),
      findBySlot: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;

    mockCreator = {
      create: jest.fn().mockResolvedValue({
        report: {} as any,
        deletedAssignmentIds: [],
        isUrgent: false,
        rulesCreated: [],
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportAbsenceHandler,
        { provide: SHIFT_ASSIGNMENT_REPOSITORY, useValue: mockAssignmentRepo },
        { provide: AbsenceReportCreator, useValue: mockCreator },
      ],
    }).compile();

    handler = module.get<ReportAbsenceHandler>(ReportAbsenceHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('delegates to AbsenceReportCreator with single-day range from assignment.date', async () => {
    const assignment = makeAssignment('a1', '2026-03-05', 'req-1');
    mockAssignmentRepo.findById.mockResolvedValue(assignment);

    await handler.execute(
      new ReportAbsenceCommand('req-1', 'a1', 'Sick', 'comp-1'),
    );

    expect(mockCreator.create).toHaveBeenCalledWith({
      companyId: 'comp-1',
      employeeId: 'req-1',
      reason: 'Sick',
      startDate: '2026-03-05',
      endDate: '2026-03-05',
      assignmentIdHint: 'a1',
    });
  });

  it('throws when assignment does not exist', async () => {
    mockAssignmentRepo.findById.mockResolvedValue(null);
    await expect(
      handler.execute(new ReportAbsenceCommand('req-1', 'a1', 'Sick', 'comp-1')),
    ).rejects.toThrow('Assignment a1 is not assigned to employee req-1');
    expect(mockCreator.create).not.toHaveBeenCalled();
  });

  it('throws when assignment belongs to a different employee', async () => {
    mockAssignmentRepo.findById.mockResolvedValue(
      makeAssignment('a3', '2026-03-05', 'other-emp'),
    );
    await expect(
      handler.execute(new ReportAbsenceCommand('req-1', 'a3', 'Sick', 'comp-1')),
    ).rejects.toThrow('Assignment a3 is not assigned to employee req-1');
    expect(mockCreator.create).not.toHaveBeenCalled();
  });
});
