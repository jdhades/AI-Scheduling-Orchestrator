import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { TakeOpenShiftCommand } from '../commands/take-open-shift.command';
import { OpenShiftClaimedEvent } from '../../domain/events/open-shift-claimed.event';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { randomUUID } from 'crypto';

@CommandHandler(TakeOpenShiftCommand)
export class TakeOpenShiftHandler implements ICommandHandler<TakeOpenShiftCommand> {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: TakeOpenShiftCommand): Promise<void> {
    const { requesterId, currentShiftId, targetShiftId, companyId } = command;

    // 1. Verify the requester's shift assignment
    const requesterAssignments = await this.shiftRepo.findAssignmentsByEmployee(requesterId, companyId);
    const requesterAssignment = requesterAssignments.find((a) => a.shiftId === currentShiftId);
    
    if (!requesterAssignment) {
      throw new Error(`Shift ${currentShiftId} is not assigned to the requesting employee`);
    }

    // 2. Verify target shift is actually open
    // Since our system assigns 1 person per shift, "open" means no active assignment exists for targetShiftId.
    const weekStart = new Date();
    const day = weekStart.getDay();
    const diff = weekStart.getDate() - day + (day === 0 ? -6 : 1);
    weekStart.setDate(diff);
    weekStart.setHours(0, 0, 0, 0);

    const companyAssignmentsW1 = await this.shiftRepo.findAssignmentsByCompanyAndWeek(companyId, weekStart);
    
    const nextWeek = new Date(weekStart);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const companyAssignmentsW2 = await this.shiftRepo.findAssignmentsByCompanyAndWeek(companyId, nextWeek);

    const targetAssignmentExists = [...companyAssignmentsW1, ...companyAssignmentsW2].find((a) => a.shiftId === targetShiftId);

    if (targetAssignmentExists) {
      throw new Error(`Shift ${targetShiftId} is no longer open or already assigned`);
    }

    // 3. Delete old assignment
    await this.shiftRepo.deleteAssignment(requesterAssignment.id);

    // 4. Create new assignment for target shift
    const newAssignment = ShiftAssignment.create({
      id: randomUUID(),
      shiftId: targetShiftId,
      employeeId: requesterId,
      companyId: companyId,
      strategyType: 'hybrid', // manual override
      fairnessSnapshot: {},
    });
    
    await this.shiftRepo.saveAssignment(newAssignment);

    // 5. Emit domain event
    this.eventBus.publish(
      new OpenShiftClaimedEvent(
        requesterId,
        currentShiftId,
        targetShiftId,
        companyId,
      ),
    );
  }
}
