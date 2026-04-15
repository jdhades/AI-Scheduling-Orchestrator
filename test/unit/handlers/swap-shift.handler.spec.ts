import { Test, TestingModule } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { SwapShiftHandler } from '../../../src/application/handlers/swap-shift.handler';
import { SwapShiftCommand } from '../../../src/application/commands/swap-shift.command';
import { ShiftSwapRequestedEvent } from '../../../src/domain/events/shift-swap-requested.event';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  IShiftAssignmentRepository,
} from '../../../src/domain/repositories/shift-assignment.repository';
import { ShiftAssignment } from '../../../src/domain/aggregates/shift-assignment.aggregate';

function makeAssignment(id: string, employeeId: string): ShiftAssignment {
  return ShiftAssignment.create({
    id,
    templateId: 'tpl-1',
    date: '2026-03-05',
    employeeId,
    companyId: 'c1',
    origin: 'membership',
    strategyType: 'hybrid',
    fairnessSnapshot: {},
    actualStartTime: new Date('2026-03-05T08:00:00Z'),
    actualEndTime: new Date('2026-03-05T16:00:00Z'),
  });
}

describe('SwapShiftHandler', () => {
  let handler: SwapShiftHandler;
  let mockRepo: jest.Mocked<IShiftAssignmentRepository>;
  let mockEventBus: jest.Mocked<EventBus>;

  beforeEach(async () => {
    mockRepo = {
      save: jest.fn(),
      deleteById: jest.fn(),
      deleteByDateRange: jest.fn(),
      findById: jest.fn(),
      findByEmployeeAndDateRange: jest.fn(),
      findByCompanyAndDateRange: jest.fn(),
      findBySlot: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;

    mockEventBus = { publish: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SwapShiftHandler,
        { provide: SHIFT_ASSIGNMENT_REPOSITORY, useValue: mockRepo },
        { provide: EventBus, useValue: mockEventBus },
      ],
    }).compile();

    handler = module.get(SwapShiftHandler);
    jest.clearAllMocks();
  });

  it('emits ShiftSwapRequestedEvent on valid swap', async () => {
    mockRepo.findById.mockImplementation(async (id) => {
      if (id === 'a1') return makeAssignment('a1', 'req-1');
      if (id === 'a2') return makeAssignment('a2', 'tgt-1');
      return null;
    });

    const result = await handler.execute(
      new SwapShiftCommand('req-1', 'a1', 'tgt-1', 'a2', 'c1'),
    );

    expect(result.swapRequestId).toMatch(/^swap-\d+$/);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.any(ShiftSwapRequestedEvent),
    );
  });

  it('throws if the requester assignment does not belong to requester', async () => {
    mockRepo.findById.mockResolvedValue(null);
    await expect(
      handler.execute(
        new SwapShiftCommand('req-1', 'a1', 'tgt-1', 'a2', 'c1'),
      ),
    ).rejects.toThrow('Assignment a1 is not assigned to the requesting employee');
  });

  it('throws if the target assignment does not belong to target', async () => {
    mockRepo.findById.mockImplementation(async (id) => {
      if (id === 'a1') return makeAssignment('a1', 'req-1');
      return null;
    });
    await expect(
      handler.execute(
        new SwapShiftCommand('req-1', 'a1', 'tgt-1', 'a2', 'c1'),
      ),
    ).rejects.toThrow('Assignment a2 is not assigned to the target employee');
  });
});
