import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetEmployeeCalendarQuery } from '../queries/get-employee-calendar.query';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

/**
 * GetEmployeeCalendarHandler — Query Handler
 *
 * Resuelve la query GetEmployeeCalendarQuery devolviendo las asignaciones
 * de turno de un empleado en el rango de fechas solicitado.
 *
 * 💡 CQRS Read Side: Lee directamente del repositorio sin pasar por dominio.
 * 💡 Multi-tenant: companyId incluido en todos los filtros.
 */
@QueryHandler(GetEmployeeCalendarQuery)
export class GetEmployeeCalendarHandler implements IQueryHandler<
  GetEmployeeCalendarQuery,
  ShiftAssignment[]
> {
  constructor(
    @Inject(SHIFT_REPOSITORY)
    private readonly shiftRepository: IShiftRepository,
  ) {}

  async execute(query: GetEmployeeCalendarQuery): Promise<ShiftAssignment[]> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    return this.shiftRepository.findAssignmentsByEmployee(
      query.employeeId,
      query.companyId,
      from,
      to,
    );
  }
}
