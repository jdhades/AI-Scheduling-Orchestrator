/**
 * Preference types supported by our scheduling engine.
 *
 * PREFERS_MORNING  → 06:00–14:00 shifts get a bonus score for this employee
 * PREFERS_EVENING  → 14:00–22:00 shifts get a bonus score
 * PREFERS_NIGHT    → 22:00–06:00 shifts get a bonus score
 * AVOID_WEEKENDS   → Saturday/Sunday shifts incur a soft-penalty cost multiplier
 * PREFERS_WEEKENDS → Saturday/Sunday shifts get a bonus, weekday shifts get minor penalty
 */
export type PreferenceType =
    | 'PREFERS_MORNING'
    | 'PREFERS_EVENING'
    | 'PREFERS_NIGHT'
    | 'AVOID_WEEKENDS'
    | 'PREFERS_WEEKENDS';

/**
 * EmployeePreference — Value Object
 *
 * A soft constraint expressing scheduling preference.
 * Weight (1–5) controls how strongly this preference modifies a candidate's score.
 */
export class EmployeePreference {
    constructor(
        public readonly id: string,
        public readonly type: PreferenceType,
        public readonly weight: number, // 1 (weak) – 5 (strong)
    ) {
        if (weight < 1 || weight > 5) {
            throw new Error(`Preference weight must be between 1 and 5. Got: ${weight}`);
        }
    }

    /**
     * Returns a cost multiplier for a given shift based on this preference.
     * Values < 1.0 make the employee more attractive for that shift (bonus).
     * Values > 1.0 make them less attractive (penalty).
     */
    getCostMultiplier(shiftStart: Date): number {
        const hour = shiftStart.getUTCHours();
        const dayOfWeek = shiftStart.getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isMorning = hour >= 6 && hour < 14;
        const isEvening = hour >= 14 && hour < 22;
        const isNight = hour >= 22 || hour < 6;

        // Scale factor: weight 1 = tiny nudge, weight 5 = strong push
        const factor = 0.05 * this.weight;

        switch (this.type) {
            case 'PREFERS_MORNING':
                return isMorning ? 1 - factor : 1;
            case 'PREFERS_EVENING':
                return isEvening ? 1 - factor : 1;
            case 'PREFERS_NIGHT':
                return isNight ? 1 - factor : 1;
            case 'AVOID_WEEKENDS':
                return isWeekend ? 1 + factor : 1;
            case 'PREFERS_WEEKENDS':
                return isWeekend ? 1 - factor : 1 + (factor * 0.5);
        }
    }
}
