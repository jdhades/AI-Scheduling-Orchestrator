import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetCompanyScheduleQuery } from '../queries/get-company-schedule.query';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

/**
 * GetCompanyScheduleHandler — Query Handler
 *
 * Devuelve todos los turnos de la empresa para una semana con sus asignaciones.
 */
@QueryHandler(GetCompanyScheduleQuery)
export class GetCompanyScheduleHandler implements IQueryHandler<
  GetCompanyScheduleQuery,
  ShiftAssignment[]
> {
  constructor(
    @Inject(SHIFT_REPOSITORY)
    private readonly shiftRepository: IShiftRepository,
  ) {}

  async execute(query: GetCompanyScheduleQuery): Promise<ShiftAssignment[]> {
    const weekStart = new Date(`${query.weekStart}T00:00:00.000Z`);
    return this.shiftRepository.findAssignmentsByCompanyAndWeek(
      query.companyId,
      weekStart,
    );
  }
}
