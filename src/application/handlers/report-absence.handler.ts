import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { AbsenceReportedEvent } from '../../domain/events/absence-reported.event';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

@CommandHandler(ReportAbsenceCommand)
export class ReportAbsenceHandler implements ICommandHandler<ReportAbsenceCommand> {
    constructor(
        @Inject(EMPLOYEE_REPOSITORY) private readonly employeeRepo: IEmployeeRepository,
        @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
        private readonly eventBus: EventBus,
    ) { }

    async execute(command: ReportAbsenceCommand): Promise<void> {
        const { employeeId, shiftId, reason, companyId } = command;

        // 1. Verify employee exists
        const employee = await this.employeeRepo.findById(employeeId, companyId);
        if (!employee) throw new Error('Employee not found');

        // 2. Verify the shift is assigned to this employee
        const assignments = await this.shiftRepo.findAssignmentsByEmployee(employeeId, companyId);
        const assignment = assignments.find(a => a.shiftId === shiftId);
        if (!assignment) {
            throw new Error(`Shift ${shiftId} is not assigned to employee ${employeeId}`);
        }

        // 3. Determine urgency (shift starts within 2 hours)
        const allShifts = await this.shiftRepo.findByCompanyAndWeek(companyId, new Date());
        const shift = allShifts.find(s => s.id === shiftId);
        const isUrgent = shift
            ? (shift.startTime.getTime() - Date.now()) <= TWO_HOURS_MS
            : false;

        // 4. Emit domain event → handler persists absence + notifies manager
        this.eventBus.publish(
            new AbsenceReportedEvent(employeeId, shiftId, reason, companyId, isUrgent),
        );
    }
}
