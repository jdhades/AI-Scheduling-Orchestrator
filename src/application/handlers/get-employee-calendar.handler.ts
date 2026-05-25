import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetEmployeeCalendarQuery } from '../queries/get-employee-calendar.query';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';

const FAR_PAST = '1970-01-01';
const FAR_FUTURE = '9999-12-31';

/**
 * Shape devuelto al cliente — assignment + templateName resuelto.
 * El nombre del template es lo que el empleado quiere ver ("Caja Mañana",
 * "Cocina Tarde"), no un UUID. Lo resolvemos en el handler para evitar
 * que el frontend tenga que hacer N queries de templates.
 */
export interface EmployeeCalendarAssignmentDTO {
  id: string;
  employeeId: string;
  templateId: string;
  templateName: string;
  date: string;
  actualStartTime: string;
  actualEndTime: string;
}

/**
 * GetEmployeeCalendarHandler — Query Handler (CQRS read side).
 * Devuelve las ShiftAssignment del empleado en el rango solicitado,
 * con templateName hidratado.
 */
@QueryHandler(GetEmployeeCalendarQuery)
export class GetEmployeeCalendarHandler implements IQueryHandler<
  GetEmployeeCalendarQuery,
  EmployeeCalendarAssignmentDTO[]
> {
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
  ) {}

  async execute(
    query: GetEmployeeCalendarQuery,
  ): Promise<EmployeeCalendarAssignmentDTO[]> {
    const from = query.from ? query.from.toISOString().split('T')[0] : FAR_PAST;
    const to = query.to ? query.to.toISOString().split('T')[0] : FAR_FUTURE;
    const [assignments, templates] = await Promise.all([
      this.assignmentRepo.findByEmployeeAndDateRange(
        query.employeeId,
        query.companyId,
        from,
        to,
      ),
      this.templateRepo.findAllByCompany(query.companyId),
    ]);
    const nameById = new Map(templates.map((t) => [t.id, t.name]));
    return assignments.map((a) => ({
      id: a.id,
      employeeId: a.employeeId,
      templateId: a.templateId,
      templateName: nameById.get(a.templateId) ?? '—',
      date: a.date,
      actualStartTime: a.actualStartTime.toISOString(),
      actualEndTime: a.actualEndTime.toISOString(),
    }));
  }
}
