import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { ShiftSwapRequestedEvent } from '../../domain/events/shift-swap-requested.event';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';

@CommandHandler(SwapShiftCommand)
export class SwapShiftHandler implements ICommandHandler<SwapShiftCommand> {
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: SwapShiftCommand): Promise<{ swapRequestId: string }> {
    const {
      requesterId,
      assignmentId,
      targetEmployeeId,
      targetAssignmentId,
      companyId,
    } = command;

    const requesterAssignment = await this.assignmentRepo.findById(
      assignmentId,
      companyId,
    );
    if (!requesterAssignment || requesterAssignment.employeeId !== requesterId) {
      throw new Error(
        `Assignment ${assignmentId} is not assigned to the requesting employee`,
      );
    }

    const targetAssignment = await this.assignmentRepo.findById(
      targetAssignmentId,
      companyId,
    );
    if (!targetAssignment || targetAssignment.employeeId !== targetEmployeeId) {
      throw new Error(
        `Assignment ${targetAssignmentId} is not assigned to the target employee`,
      );
    }

    const swapRequestId = `swap-${Date.now()}`;
    this.eventBus.publish(
      new ShiftSwapRequestedEvent(
        requesterId,
        targetEmployeeId,
        assignmentId,
        companyId,
        swapRequestId,
      ),
    );

    return { swapRequestId };
  }
}
