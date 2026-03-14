/**
 * EmployeeAvailability — Value Object
 *
 * Represents a recurring structural availability window for an employee.
 * e.g. "Every Monday, from 09:00 to 17:00"
 *
 * day_of_week follows JavaScript convention: 0=Sunday, 1=Monday, ..., 6=Saturday
 */
export class EmployeeAvailability {
    constructor(
        public readonly id: string,
        public readonly dayOfWeek: number,   // 0 (Sun) – 6 (Sat)
        public readonly startTime: string,   // "HH:MM" in local business time
        public readonly endTime: string,     // "HH:MM" in local business time
    ) {
        if (dayOfWeek < 0 || dayOfWeek > 6) {
            throw new Error(`Invalid dayOfWeek: ${dayOfWeek}. Must be between 0 and 6.`);
        }
    }

    /**
     * Checks if a given shift (UTC DateTimes) falls within this availability window.
     * Compares by the UTC hour values.
     */
    coversShift(shiftStart: Date, shiftEnd: Date): boolean {
        const shiftDayOfWeek = shiftStart.getUTCDay();
        if (shiftDayOfWeek !== this.dayOfWeek) return false;

        const [availStartH, availStartM] = this.startTime.split(':').map(Number);
        const [availEndH, availEndM] = this.endTime.split(':').map(Number);

        const availStartMins = availStartH * 60 + availStartM;
        const availEndMins = availEndH * 60 + availEndM;

        const shiftStartMins = shiftStart.getUTCHours() * 60 + shiftStart.getUTCMinutes();
        const shiftEndMins = shiftEnd.getUTCHours() * 60 + shiftEnd.getUTCMinutes();

        return shiftStartMins >= availStartMins && shiftEndMins <= availEndMins;
    }
}
