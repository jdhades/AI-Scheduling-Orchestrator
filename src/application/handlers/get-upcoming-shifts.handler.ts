import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetUpcomingShiftsQuery } from '../queries/get-upcoming-shifts.query';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import type { Shift } from '../../domain/aggregates/shift.aggregate';

export interface UpcomingShiftDto {
  shiftId: string;
  startTime: Date;
  endTime: Date;
}

@QueryHandler(GetUpcomingShiftsQuery)
export class GetUpcomingShiftsHandler implements IQueryHandler<
  GetUpcomingShiftsQuery,
  UpcomingShiftDto[]
> {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
  ) {}

  async execute(query: GetUpcomingShiftsQuery): Promise<UpcomingShiftDto[]> {
    const { employeeId, companyId, limit } = query;

    const now = new Date();
    const twoWeeksFromNow = new Date(now);
    twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);

    const assignments = await this.shiftRepo.findAssignmentsByEmployee(
      employeeId,
      companyId,
      now,
      twoWeeksFromNow,
    );

    if (assignments.length === 0) {
      return [];
    }

    const monday1 = this._getMonday(now);
    const nextWeek = new Date(monday1);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const monday2 = this._getMonday(nextWeek);

    const shiftsWeek1 = await this.shiftRepo.findByCompanyAndWeek(
      companyId,
      monday1,
    );
    const shiftsWeek2 = await this.shiftRepo.findByCompanyAndWeek(
      companyId,
      monday2,
    );
    const allShifts = [...shiftsWeek1, ...shiftsWeek2];

    const upcoming: UpcomingShiftDto[] = [];
    for (const assignment of assignments) {
      const shift = allShifts.find((s) => s.id === assignment.shiftId);
      if (!shift) continue;
      // Only upcoming shifts
      if (shift.endTime > now) {
        upcoming.push({
          shiftId: shift.id,
          startTime: shift.startTime,
          endTime: shift.endTime,
        });
      }
    }

    // Sort by start time ascending
    upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    return upcoming.slice(0, limit);
  }

  private _getMonday(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }
}
