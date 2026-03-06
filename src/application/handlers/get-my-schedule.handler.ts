import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import type { Shift } from '../../domain/aggregates/shift.aggregate';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

@QueryHandler(GetMyScheduleQuery)
export class GetMyScheduleHandler implements IQueryHandler<GetMyScheduleQuery, string> {
    constructor(
        @Inject(SHIFT_REPOSITORY) private readonly shiftRepo: IShiftRepository,
    ) { }

    async execute(query: GetMyScheduleQuery): Promise<string> {
        const { employeeId, companyId, weekStart } = query;

        const monday = weekStart ? new Date(weekStart) : this._getCurrentMonday();
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        const assignments = await this.shiftRepo.findAssignmentsByEmployee(
            employeeId, companyId, monday, sunday,
        );

        if (assignments.length === 0) {
            return '📅 No tienes turnos asignados esta semana.';
        }

        const shifts = await this.shiftRepo.findByCompanyAndWeek(companyId, monday);
        return this._formatSchedule(assignments, shifts);
    }

    private _formatSchedule(assignments: ShiftAssignment[], shifts: Shift[]): string {
        const lines: string[] = ['📅 *Tu horario esta semana:*', ''];
        const dayEmoji: Record<number, string> = { 0: '🌞', 1: '📅', 2: '📅', 3: '📅', 4: '📅', 5: '📅', 6: '🌞' };

        for (const assignment of assignments) {
            const shift = shifts.find(s => s.id === assignment.shiftId);
            if (!shift) continue;

            const start = shift.startTime;
            const end = shift.endTime;

            const dayName = start.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
            const startTime = start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            const endTime = end.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

            lines.push(`${dayEmoji[start.getDay()]} ${dayName} — ${startTime} a ${endTime}`);
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
