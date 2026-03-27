import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
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
  ) {}

  async execute(query: GetMyScheduleQuery): Promise<string> {
    const { employeeId, companyId, weekStart } = query;

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
        return `📅 No tienes turnos asignados para la semana del ${monday.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}.`;
      }
      return '📅 No tienes turnos asignados esta semana.';
    }

    const shifts = await this.shiftRepo.findByCompanyAndWeek(companyId, monday);
    return this._formatSchedule(assignments, shifts, weekStart, monday);
  }

  private _formatSchedule(
    assignments: ShiftAssignment[],
    shifts: Shift[],
    hasWeekStart?: string,
    monday?: Date,
  ): string {
    const title = hasWeekStart && monday
      ? `📅 *Tu horario para la semana del ${monday.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}:*`
      : '📅 *Tu horario esta semana:*';
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

      const dayName = start.toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      });
      const startTime = start.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const endTime = end.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
      });

      lines.push(
        `${dayEmoji[start.getDay()]} ${dayName} — ${startTime} a ${endTime} (ID: ${shift.id.substring(0, 6)})`,
      );
    }

    lines.push('', '¿Necesitas algo más?');
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
