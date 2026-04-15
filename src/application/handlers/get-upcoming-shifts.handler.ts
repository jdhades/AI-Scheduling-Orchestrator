import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetUpcomingShiftsQuery } from '../queries/get-upcoming-shifts.query';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import type { ShiftTemplate } from '../../domain/aggregates/shift-template.aggregate';

export interface UpcomingShiftDto {
  /** UUID PK de la assignment — el identificador canónico para swap/absence. */
  assignmentId: string;
  /** Alias deprecated; mismo valor que `assignmentId`. */
  shiftId: string;
  startTime: Date;
  endTime: Date;
}

@QueryHandler(GetUpcomingShiftsQuery)
export class GetUpcomingShiftsHandler
  implements IQueryHandler<GetUpcomingShiftsQuery, UpcomingShiftDto[]>
{
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
  ) {}

  async execute(query: GetUpcomingShiftsQuery): Promise<UpcomingShiftDto[]> {
    const { employeeId, companyId, limit } = query;

    const now = new Date();
    const in14Days = new Date(now);
    in14Days.setDate(in14Days.getDate() + 14);

    const fromISO = now.toISOString().split('T')[0];
    const toISO = in14Days.toISOString().split('T')[0];

    const assignments = await this.assignmentRepo.findByEmployeeAndDateRange(
      employeeId,
      companyId,
      fromISO,
      toISO,
    );
    if (assignments.length === 0) return [];

    const templateIds = Array.from(new Set(assignments.map((a) => a.templateId)));
    const templates = new Map<string, ShiftTemplate>();
    await Promise.all(
      templateIds.map(async (id) => {
        const t = await this.templateRepo.findById(id, companyId);
        if (t) templates.set(id, t);
      }),
    );

    const upcoming: UpcomingShiftDto[] = [];
    for (const a of assignments) {
      const tpl = templates.get(a.templateId);
      if (!tpl) continue;
      const start = this._combine(a.date, tpl.startTime);
      let end = this._combine(a.date, tpl.endTime);
      if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      if (end <= now) continue;
      upcoming.push({ assignmentId: a.id, shiftId: a.id, startTime: start, endTime: end });
    }

    upcoming.sort((x, y) => x.startTime.getTime() - y.startTime.getTime());
    return upcoming.slice(0, limit);
  }

  private _combine(dateISO: string, hhmm: string): Date {
    const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
    const d = new Date(`${dateISO}T00:00:00Z`);
    d.setUTCHours(h, m, 0, 0);
    return d;
  }
}
