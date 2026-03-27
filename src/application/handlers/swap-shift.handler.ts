import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { ShiftSwapRequestedEvent } from '../../domain/events/shift-swap-requested.event';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';

@CommandHandler(SwapShiftCommand)
export class SwapShiftHandler implements ICommandHandler<SwapShiftCommand> {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: SwapShiftCommand): Promise<{ swapRequestId: string }> {
    const { requesterId, shiftId, targetEmployeeId, targetShiftId, companyId } =
      command;

    // 1. Verify the requester's shift assignment
    const requesterAssignments =
      await this.shiftRepo.findAssignmentsByEmployee(requesterId, companyId);
    const requesterAssignment = requesterAssignments.find(
      (a) => a.shiftId === shiftId,
    );
    if (!requesterAssignment) {
      throw new Error(
        `Shift ${shiftId} is not assigned to the requesting employee`,
      );
    }

    // 2. Verify the target's shift assignment
    const targetAssignments =
      await this.shiftRepo.findAssignmentsByEmployee(
        targetEmployeeId,
        companyId,
      );
    const targetAssignment = targetAssignments.find(
      (a) => a.shiftId === targetShiftId,
    );
    if (!targetAssignment) {
      throw new Error(
        `Shift ${targetShiftId} is not assigned to the target employee`,
      );
    }

    // 3. Emit domain event → listener notifies both employees
    const swapRequestId = `swap-${Date.now()}`;
    this.eventBus.publish(
      new ShiftSwapRequestedEvent(
        requesterId,
        targetEmployeeId,
        shiftId,
        companyId,
        swapRequestId,
      ),
    );

    return { swapRequestId };
  }
}
