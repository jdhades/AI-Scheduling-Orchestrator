import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { RequestDayOffCommand } from '../commands/request-day-off.command';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import { CompanyPreferencesService } from '../services/company-preferences.service';
import { weekStartOf } from '../../domain/shared/week';

@CommandHandler(RequestDayOffCommand)
export class RequestDayOffHandler implements ICommandHandler<RequestDayOffCommand> {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
    private readonly eventBus: EventBus,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  async execute(command: RequestDayOffCommand): Promise<{ message: string }> {
    const { employeeId, date, reason, companyId } = command;

    // 1. Verify employee exists
    const employee = await this.employeeRepo.findById(employeeId, companyId);
    if (!employee) throw new Error('Employee not found');

    // 2. Check no shift already assigned on that date
    const weekStartsOn =
      await this.companyPreferences.getWeekStartsOn(companyId);
    const requestedDate = new Date(date);
    const weekStart = weekStartOf(requestedDate, weekStartsOn);
    const assignments = await this.shiftRepo.findAssignmentsByEmployee(
      employeeId,
      companyId,
      weekStart,
    );
    const shifts = await this.shiftRepo.findByCompanyAndWeek(
      companyId,
      weekStart,
    );
    const hasShiftOnDate = assignments.some((a) => {
      const shift = shifts.find((s) => s.id === a.shiftId);
      if (!shift) return false;
      return shift.startTime.toDateString() === requestedDate.toDateString();
    });

    if (hasShiftOnDate) {
      return {
        message:
          `⚠️ Ya tienes un turno asignado el ${date}. ` +
          `Para pedir el día libre primero debes hablar con tu manager para reasignar el turno.`,
      };
    }

    // 3. Emit event (manager notification via event handler)
    this.eventBus.publish({
      employeeId,
      date,
      reason,
      companyId,
      employeePhone: employee.phone,
    });

    return {
      message: `✅ Tu solicitud de día libre para el ${date} fue enviada al manager para aprobación.`,
    };
  }
}
