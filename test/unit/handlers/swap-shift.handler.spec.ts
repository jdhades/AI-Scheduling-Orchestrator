import { Test, TestingModule } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { SwapShiftHandler } from '../../../src/application/handlers/swap-shift.handler';
import { SwapShiftCommand } from '../../../src/application/commands/swap-shift.command';
import { ShiftSwapRequestedEvent } from '../../../src/domain/events/shift-swap-requested.event';
import {
  SHIFT_REPOSITORY,
  IShiftRepository,
} from '../../../src/domain/repositories/shift.repository';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';

describe('SwapShiftHandler', () => {
  let handler: SwapShiftHandler;
  let mockShiftRepo: jest.Mocked<IShiftRepository>;
  let mockEventBus: jest.Mocked<EventBus>;

  beforeEach(async () => {
    mockShiftRepo = {
      findById: jest.fn(),
      findByCompanyAndWeek: jest.fn(),
      findAssignmentsByEmployee: jest.fn(),
      findAssignmentsByCompanyAndWeek: jest.fn(),
      save: jest.fn(),
      saveAssignment: jest.fn(),
      deleteAssignment: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;

    mockEventBus = {
      publish: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SwapShiftHandler,
        { provide: SHIFT_REPOSITORY, useValue: mockShiftRepo },
        { provide: EventBus, useValue: mockEventBus },
      ],
    }).compile();

    handler = module.get<SwapShiftHandler>(SwapShiftHandler);
    jest.clearAllMocks();
  });

  it('should successfully emit a shift swap requested event', async () => {
    mockShiftRepo.findAssignmentsByEmployee.mockImplementation(
      async (empId) => {
        if (empId === 'req-1') {
          return [
            ShiftAssignment.create({
              id: 'a1',
              shiftId: 'shift-1',
              employeeId: 'req-1',
              companyId: 'c1',
              strategyType: 'HYBRID' as any,
              fairnessSnapshot: {},
            }),
          ];
        }
        if (empId === 'tgt-1') {
          return [
            ShiftAssignment.create({
              id: 'a2',
              shiftId: 'shift-2',
              employeeId: 'tgt-1',
              companyId: 'c1',
              strategyType: 'HYBRID' as any,
              fairnessSnapshot: {},
            }),
          ];
        }
        return [];
      },
    );

    const command = new SwapShiftCommand('req-1', 'shift-1', 'tgt-1', 'shift-2', 'comp-1');
    const result = await handler.execute(command);

    expect(result.swapRequestId).toMatch(/^swap-\d+$/);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.any(ShiftSwapRequestedEvent),
    );
  });

  it('should throw if requester is not assigned to the shift', async () => {
    mockShiftRepo.findAssignmentsByEmployee.mockResolvedValue([]);

    const command = new SwapShiftCommand('req-1', 'shift-1', 'tgt-1', 'shift-2', 'comp-1');
    await expect(handler.execute(command)).rejects.toThrow(
      'Shift shift-1 is not assigned to the requesting employee',
    );
  });

  it('should throw if target is not assigned to the target shift', async () => {
    mockShiftRepo.findAssignmentsByEmployee.mockImplementation(
      async (empId) => {
        if (empId === 'req-1') {
          return [
            ShiftAssignment.create({
              id: 'a1',
              shiftId: 'shift-1',
              employeeId: 'req-1',
              companyId: 'c1',
              strategyType: 'HYBRID' as any,
              fairnessSnapshot: {},
            }),
          ];
        }
        return []; // target has no assignments
      },
    );

    const command = new SwapShiftCommand('req-1', 'shift-1', 'tgt-1', 'shift-2', 'comp-1');
    await expect(handler.execute(command)).rejects.toThrow(
      'Shift shift-2 is not assigned to the target employee',
    );
  });
});
