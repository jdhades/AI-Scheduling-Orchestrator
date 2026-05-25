import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import type { ShiftTemplate } from '../../domain/aggregates/shift-template.aggregate';
import { CompanyPreferencesService } from '../services/company-preferences.service';
import { weekStartOf, type WeekStartsOn } from '../../domain/shared/week';

@QueryHandler(GetMyScheduleQuery)
export class GetMyScheduleHandler implements IQueryHandler<
  GetMyScheduleQuery,
  string
> {
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly i18n: I18nService,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  async execute(query: GetMyScheduleQuery): Promise<string> {
    const { employeeId, companyId, weekStart, locale, forEmployeeName } = query;
    const weekStartsOn =
      await this.companyPreferences.getWeekStartsOn(companyId);

    const reference = weekStart
      ? new Date(`${weekStart}T00:00:00.000Z`)
      : new Date();
    const monday = weekStartOf(reference, weekStartsOn);
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);

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

    const templateIds = Array.from(
      new Set(assignments.map((a) => a.templateId)),
    );
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
      weekStartsOn,
      forEmployeeName,
    );
  }

  private _formatSchedule(
    assignments: ShiftAssignment[],
    templates: Map<string, ShiftTemplate>,
    locale: string,
    hasWeekStart: string | undefined,
    weekStartDate: Date,
    weekStartsOn: WeekStartsOn,
    forEmployeeName?: string,
  ): string {
    const dateStr = hasWeekStart
      ? weekStartDate.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', {
          day: 'numeric',
          month: 'short',
        })
      : '';
    const titleKey = hasWeekStart
      ? forEmployeeName
        ? 'bot.schedule.title_that_week_other'
        : 'bot.schedule.title_that_week'
      : forEmployeeName
        ? 'bot.schedule.title_this_week_other'
        : 'bot.schedule.title_this_week';
    const titleArgs: Record<string, string> = {};
    if (hasWeekStart) titleArgs.date = dateStr;
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
      startStr: string; // 'HH:MM' literal, sin conversión TZ
      endStr: string;
    };
    const byDay = new Map<number, Row[]>();
    for (const a of assignments) {
      const tpl = templates.get(a.templateId);
      if (!tpl) continue;
      const startStr = tpl.startTime.slice(0, 5);
      const endStr = tpl.endTime.slice(0, 5);
      // Día de la semana resuelto desde la fecha UTC del slot — evita
      // el shift de un día cuando el server corre en TZ no-UTC.
      const day = new Date(`${a.date}T00:00:00Z`).getUTCDay();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ assignment: a, startStr, endStr });
    }

    const code = locale === 'en' ? 'en-US' : 'es-ES';
    const startDow = weekStartsOn === 'sunday' ? 0 : 1;
    const daysOrder = Array.from({ length: 7 }, (_, i) => (startDow + i) % 7);
    const currentDayDate = new Date(weekStartDate);

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
        rows.sort((a, b) => a.startStr.localeCompare(b.startStr));
        for (const item of rows) {
          lines.push(
            `${emoji} ${dayName} — ${item.startStr} a ${item.endStr} (ID: ${item.assignment.id.substring(0, 6)})`,
          );
        }
      }
      currentDayDate.setUTCDate(currentDayDate.getUTCDate() + 1);
    }

    lines.push('', this.i18n.t('bot.schedule.anything_else', { lang: locale }));
    return lines.join('\n');
  }
}
