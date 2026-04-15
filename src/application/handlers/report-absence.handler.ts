import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { AbsenceReportedEvent } from '../../domain/events/absence-reported.event';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

@CommandHandler(ReportAbsenceCommand)
export class ReportAbsenceHandler implements ICommandHandler<ReportAbsenceCommand> {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ReportAbsenceCommand): Promise<void> {
    const { employeeId, assignmentId, reason, companyId } = command;

    const employee = await this.employeeRepo.findById(employeeId, companyId);
    if (!employee) throw new Error('Employee not found');

    const assignment = await this.assignmentRepo.findById(
      assignmentId,
      companyId,
    );
    if (!assignment || assignment.employeeId !== employeeId) {
      throw new Error(
        `Assignment ${assignmentId} is not assigned to employee ${employeeId}`,
      );
    }

    await this.assignmentRepo.deleteById(assignmentId, companyId);

    // Urgencia: se calcula contra la hora de inicio del template sobre la fecha
    // de la assignment. Sin la tabla legacy `shifts`, derivamos el instante
    // desde template.startTime + assignment.date.
    let isUrgent = false;
    const template = await this.templateRepo.findById(assignment.templateId, companyId);
    if (template) {
      const [h, m] = template.startTime.split(':').map((n) => parseInt(n, 10));
      const slotStart = new Date(`${assignment.date}T00:00:00Z`);
      slotStart.setUTCHours(h, m, 0, 0);
      isUrgent = slotStart.getTime() - Date.now() <= TWO_HOURS_MS;
    }

    this.eventBus.publish(
      new AbsenceReportedEvent(
        employeeId,
        assignmentId,
        reason,
        companyId,
        isUrgent,
      ),
    );
  }
}
