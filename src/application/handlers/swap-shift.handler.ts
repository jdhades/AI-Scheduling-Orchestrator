import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { ShiftSwapRequestedEvent } from '../../domain/events/shift-swap-requested.event';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';

@CommandHandler(SwapShiftCommand)
export class SwapShiftHandler implements ICommandHandler<SwapShiftCommand> {
    constructor(
        @Inject(EMPLOYEE_REPOSITORY) private readonly employeeRepo: IEmployeeRepository,
        @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
        private readonly eventBus: EventBus,
    ) { }

    async execute(command: SwapShiftCommand): Promise<{ swapRequestId: string }> {
        const { requesterId, targetEmployeePhone, shiftId, companyId } = command;

        // 1. Load requester and target employee
        const requester = await this.employeeRepo.findById(requesterId, companyId);
        if (!requester) throw new Error('Requester employee not found');

        const target = await this.employeeRepo.findByPhone(targetEmployeePhone, companyId);
        if (!target) throw new Error(`No employee found with phone ${targetEmployeePhone}`);

        // 2. Find the shift assignment for the requester
        const assignments = await this.shiftRepo.findAssignmentsByEmployee(requesterId, companyId);
        const assignment = assignments.find(a => a.shiftId === shiftId);
        if (!assignment) {
            throw new Error(`Shift ${shiftId} is not assigned to the requesting employee`);
        }

        // 3. Load shifts and check for overlap on target's side
        const allShifts = await this.shiftRepo.findByCompanyAndWeek(companyId, new Date());
        const requestedShift = allShifts.find(s => s.id === shiftId);
        if (!requestedShift) throw new Error(`Shift ${shiftId} not found`);

        const targetAssignments = await this.shiftRepo.findAssignmentsByEmployee(target.id, companyId);
        const hasConflict = targetAssignments.some(ta => {
            const shift = allShifts.find(s => s.id === ta.shiftId);
            return shift && requestedShift.overlapsWith(shift);
        });
        if (hasConflict) {
            throw new Error('Target employee has a conflicting shift on that time slot');
        }

        // 4. Emit domain event → listener notifies both employees
        const swapRequestId = `swap-${Date.now()}`;
        this.eventBus.publish(
            new ShiftSwapRequestedEvent(requesterId, target.id, shiftId, companyId, swapRequestId),
        );

        return { swapRequestId };
    }
}
