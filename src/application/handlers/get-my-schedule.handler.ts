import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import type { Shift } from '../../domain/aggregates/shift.aggregate';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

@QueryHandler(GetMyScheduleQuery)
export class GetMyScheduleHandler implements IQueryHandler<
  GetMyScheduleQuery,
  string
> {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
    private readonly i18n: I18nService,
  ) {}

  async execute(query: GetMyScheduleQuery): Promise<string> {
    const { employeeId, companyId, weekStart, locale } = query;

    let monday = this._getCurrentMonday();
    if (weekStart) {
      // Force noon to avoid UTC midnight dropping into the previous day locally
      monday = new Date(weekStart + 'T12:00:00');
      const day = monday.getDay();
      const diff = monday.getDate() - day + (day === 0 ? -6 : 1);
      monday.setDate(diff);
      monday.setHours(0, 0, 0, 0);
    }
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const assignments = await this.shiftRepo.findAssignmentsByEmployee(
      employeeId,
      companyId,
      monday,
      sunday,
    );

    if (assignments.length === 0) {
      if (weekStart) {
        const dateStr = monday.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', { day: 'numeric', month: 'short' });
        return this.i18n.t('bot.schedule.none_that_week', { lang: locale, args: { date: dateStr } });
      }
      return this.i18n.t('bot.schedule.none_this_week', { lang: locale });
    }

    const shifts = await this.shiftRepo.findByCompanyAndWeek(companyId, monday);
    return this._formatSchedule(assignments, shifts, locale, weekStart, monday);
  }

  private _formatSchedule(
    assignments: ShiftAssignment[],
    shifts: Shift[],
    locale: string,
    hasWeekStart?: string,
    monday?: Date,
  ): string {
    const title = hasWeekStart && monday
      ? this.i18n.t('bot.schedule.title_that_week', { lang: locale, args: { date: monday.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', { day: 'numeric', month: 'short' }) } })
      : this.i18n.t('bot.schedule.title_this_week', { lang: locale });
    const lines: string[] = [title, ''];
    const dayEmoji: Record<number, string> = {
      0: '🌞',
      1: '📅',
      2: '📅',
      3: '📅',
      4: '📅',
      5: '📅',
      6: '🌞',
    };

    for (const assignment of assignments) {
      const shift = shifts.find((s) => s.id === assignment.shiftId);
      if (!shift) continue;

      const start = shift.startTime;
      const end = shift.endTime;

      const code = locale === 'en' ? 'en-US' : 'es-ES';
      const dayName = start.toLocaleDateString(code, {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      });
      const startTime = start.toLocaleTimeString(code, {
        hour: '2-digit',
        minute: '2-digit',
      });
      const endTime = end.toLocaleTimeString(code, {
        hour: '2-digit',
        minute: '2-digit',
      });

      lines.push(
        `${dayEmoji[start.getDay()]} ${dayName} — ${startTime} a ${endTime} (ID: ${shift.id.substring(0, 6)})`,
      );
    }

    lines.push('', this.i18n.t('bot.schedule.anything_else', { lang: locale }));
    return lines.join('\n');
  }

  private _getCurrentMonday(): Date {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    now.setDate(diff);
    now.setHours(0, 0, 0, 0);
    return now;
  }
}
