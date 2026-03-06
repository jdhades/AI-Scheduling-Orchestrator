import { Shift } from '../aggregates/shift.aggregate';

export class FairnessPolicy {
    constructor(private readonly maxHoursPerWeek: number) { }

    isAssignmentFair(candidateShift: Shift, historicalShifts: Shift[]): boolean {
        const totalHours = historicalShifts.reduce((acc, s) => acc + s.getDuration(), 0);
        return totalHours + candidateShift.getDuration() <= this.maxHoursPerWeek;
    }
}