import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetEmployeeCalendarQuery } from '../queries/get-employee-calendar.query';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

const FAR_PAST = '1970-01-01';
const FAR_FUTURE = '9999-12-31';

/**
 * GetEmployeeCalendarHandler — Query Handler (CQRS read side).
 * Devuelve las ShiftAssignment del empleado en el rango solicitado.
 */
@QueryHandler(GetEmployeeCalendarQuery)
export class GetEmployeeCalendarHandler
  implements IQueryHandler<GetEmployeeCalendarQuery, ShiftAssignment[]>
{
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
  ) {}

  async execute(query: GetEmployeeCalendarQuery): Promise<ShiftAssignment[]> {
    const from = query.from
      ? query.from.toISOString().split('T')[0]
      : FAR_PAST;
    const to = query.to ? query.to.toISOString().split('T')[0] : FAR_FUTURE;
    return this.assignmentRepo.findByEmployeeAndDateRange(
      query.employeeId,
      query.companyId,
      from,
      to,
    );
  }
}
