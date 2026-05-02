import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import type { ShiftTemplate } from '../../domain/aggregates/shift-template.aggregate';

@QueryHandler(GetMyScheduleQuery)
export class GetMyScheduleHandler
  implements IQueryHandler<GetMyScheduleQuery, string>
{
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly i18n: I18nService,
  ) {}

  async execute(query: GetMyScheduleQuery): Promise<string> {
    const { employeeId, companyId, weekStart, locale, forEmployeeName } = query;

    let monday = this._getCurrentMonday();
    if (weekStart) {
      monday = new Date(weekStart + 'T12:00:00');
      const day = monday.getDay();
      const diff = monday.getDate() - day + (day === 0 ? -6 : 1);
      monday.setDate(diff);
      monday.setHours(0, 0, 0, 0);
    }
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const fromISO = monday.toISOString().split('T')[0];
    const toISO = sunday.toISOString().split('T')[0];

    const assignments = await this.assignmentRepo.findByEmployeeAndDateRange(
      employeeId,
      companyId,
      fromISO,
      toISO,
    );

    if (assignments.length === 0) {
      if (weekStart) {
        const dateStr = monday.toLocaleDateString(
          locale === 'en' ? 'en-US' : 'es-ES',
          { day: 'numeric', month: 'short' },
        );
        return this.i18n.t(
          forEmployeeName
            ? 'bot.schedule.none_that_week_other'
            : 'bot.schedule.none_that_week',
          {
            lang: locale,
            args: forEmployeeName
              ? { date: dateStr, name: forEmployeeName }
              : { date: dateStr },
          },
        );
      }
      return this.i18n.t(
        forEmployeeName
          ? 'bot.schedule.none_this_week_other'
          : 'bot.schedule.none_this_week',
        {
          lang: locale,
          args: forEmployeeName ? { name: forEmployeeName } : {},
        },
      );
    }

    const templateIds = Array.from(new Set(assignments.map((a) => a.templateId)));
    const templates = new Map<string, ShiftTemplate>();
    await Promise.all(
      templateIds.map(async (id) => {
        const t = await this.templateRepo.findById(id, companyId);
        if (t) templates.set(id, t);
      }),
    );

    return this._formatSchedule(
      assignments,
      templates,
      locale,
      weekStart,
      monday,
      forEmployeeName,
    );
  }

  private _formatSchedule(
    assignments: ShiftAssignment[],
    templates: Map<string, ShiftTemplate>,
    locale: string,
    hasWeekStart?: string,
    monday?: Date,
    forEmployeeName?: string,
  ): string {
    const dateStr =
      hasWeekStart && monday
        ? monday.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', {
            day: 'numeric',
            month: 'short',
          })
        : '';
    const titleKey =
      hasWeekStart && monday
        ? forEmployeeName
          ? 'bot.schedule.title_that_week_other'
          : 'bot.schedule.title_that_week'
        : forEmployeeName
          ? 'bot.schedule.title_this_week_other'
          : 'bot.schedule.title_this_week';
    const titleArgs: Record<string, string> = {};
    if (hasWeekStart && monday) titleArgs.date = dateStr;
    if (forEmployeeName) titleArgs.name = forEmployeeName;
    const title = this.i18n.t(titleKey, { lang: locale, args: titleArgs });
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

    type Row = {
      assignment: ShiftAssignment;
      start: Date;
      end: Date;
    };
    const byDay = new Map<number, Row[]>();
    for (const a of assignments) {
      const tpl = templates.get(a.templateId);
      if (!tpl) continue;
      const start = this._combine(a.date, tpl.startTime);
      let end = this._combine(a.date, tpl.endTime);
      if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      const day = start.getDay();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ assignment: a, start, end });
    }

    const code = locale === 'en' ? 'en-US' : 'es-ES';
    const daysOrder = [1, 2, 3, 4, 5, 6, 0];
    const currentDayDate = monday ? new Date(monday) : this._getCurrentMonday();

    for (const dayIndex of daysOrder) {
      const dayName = currentDayDate.toLocaleDateString(code, {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      });
      const emoji = dayEmoji[dayIndex];

      if (!byDay.has(dayIndex)) {
        lines.push(`${emoji} ${dayName} — Día Libre 🌴`);
      } else {
        const rows = byDay.get(dayIndex)!;
        rows.sort((a, b) => a.start.getTime() - b.start.getTime());
        for (const item of rows) {
          const startTime = item.start.toLocaleTimeString(code, {
            hour: '2-digit',
            minute: '2-digit',
          });
          const endTime = item.end.toLocaleTimeString(code, {
            hour: '2-digit',
            minute: '2-digit',
          });
          lines.push(
            `${emoji} ${dayName} — ${startTime} a ${endTime} (ID: ${item.assignment.id.substring(0, 6)})`,
          );
        }
      }
      currentDayDate.setDate(currentDayDate.getDate() + 1);
    }

    lines.push('', this.i18n.t('bot.schedule.anything_else', { lang: locale }));
    return lines.join('\n');
  }

  private _combine(dateISO: string, hhmm: string): Date {
    const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
    const d = new Date(`${dateISO}T00:00:00Z`);
    d.setUTCHours(h, m, 0, 0);
    return d;
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
