import { ScheduleValidatorService } from '../../../src/domain/services/schedule-validator.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RANGES = { junior: 6, intermediate: 24, senior: 999 };
const NO_RULES: any[] = [];

function makeEmployee(id: string, availability?: EmployeeAvailability[]): Employee {
    return Employee.fromPersistence({
        id,
        companyId: 'company-1',
        name: 'Test Employee',
        role: 'employee',
        phoneNumber: PhoneNumber.create('+34612345678'),
        experience: new ExperienceLevel(12, RANGES),
        availability,
    });
}

function makeShift(id: string, startIso: string, endIso: string): Shift {
    return Shift.create({
        id,
        companyId: 'company-1',
        startTime: new Date(startIso),
        endTime: new Date(endIso),
        requiredSkillId: null,
        requiredSkillLevel: 'junior',
        requiredExperienceMonths: 0,
        demandScore: DemandWeight.create(5),
        undesirableWeight: UndesirableWeight.create(1),
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScheduleValidatorService — Phase 1 Constraints', () => {
    let validator: ScheduleValidatorService;

    beforeEach(() => {
        validator = new ScheduleValidatorService();
    });

    // ─── Structural Availability ──────────────────────────────────────────────

    describe('Structural Availability (Hard Constraint)', () => {

        it('passes when employee has no availability windows (always available)', () => {
            const emp = makeEmployee('e1', []); // empty = no restriction
            const shift = makeShift('s1', '2026-03-09T09:00:00Z', '2026-03-09T17:00:00Z'); // Monday
            const assigned = new Map([['e1', []]]);

            const result = validator.validate('s1', 'e1', [emp], [shift], assigned, NO_RULES);
            expect(result.valid).toBe(true);
        });

        it('passes when employee has a matching availability window', () => {
            // Monday (dayOfWeek=1) 09:00–17:00
            const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
            const emp = makeEmployee('e1', [mondayWindow]);
            const shift = makeShift('s1', '2026-03-09T09:00:00Z', '2026-03-09T17:00:00Z'); // Monday
            const assigned = new Map([['e1', []]]);

            const result = validator.validate('s1', 'e1', [emp], [shift], assigned, NO_RULES);
            expect(result.valid).toBe(true);
        });

        it('fails when shift falls outside all availability windows', () => {
            // Only Monday window, but shift is on Tuesday
            const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
            const emp = makeEmployee('e1', [mondayWindow]);
            const shift = makeShift('s1', '2026-03-10T09:00:00Z', '2026-03-10T17:00:00Z'); // Tuesday
            const assigned = new Map([['e1', []]]);

            const result = validator.validate('s1', 'e1', [emp], [shift], assigned, NO_RULES);
            expect(result.valid).toBe(false);
            expect(result.violations.some(v => v.includes('no availability window'))).toBe(true);
        });
    });

    // ─── Minimum Shift Gap (Anti-Clopening) ───────────────────────────────────

    describe('Minimum Shift Gap (Hard Constraint — 11h rest)', () => {

        it('passes when gap between shifts is exactly 11 hours (boundary)', () => {
            const emp = makeEmployee('e1', []);
            // First shift ends at 22:00, next one starts at 09:00 next day = 11h gap
            const prevShift = makeShift('s-prev', '2026-03-09T14:00:00Z', '2026-03-09T22:00:00Z');
            const nextShift = makeShift('s-next', '2026-03-10T09:00:00Z', '2026-03-10T17:00:00Z');
            const assigned = new Map([['e1', [prevShift]]]);

            const result = validator.validate('s-next', 'e1', [emp], [prevShift, nextShift], assigned, NO_RULES);
            // 11h gap exactly = NOT a violation (< minGapMs means violation, = means ok)
            expect(result.valid).toBe(true);
        });

        it('fails when rest period between shifts is less than 11 hours', () => {
            const emp = makeEmployee('e1', []);
            // Last shift ends 22:00, next shift starts 06:00 next day = only 8h gap
            const prevShift = makeShift('s-prev', '2026-03-09T14:00:00Z', '2026-03-09T22:00:00Z');
            const nextShift = makeShift('s-next', '2026-03-10T06:00:00Z', '2026-03-10T14:00:00Z');
            const assigned = new Map([['e1', [prevShift]]]);

            const result = validator.validate('s-next', 'e1', [emp], [prevShift, nextShift], assigned, NO_RULES);
            expect(result.valid).toBe(false);
            expect(result.violations.some(v => v.includes('rest'))).toBe(true);
        });

        it('passes when shifts are on different days with more than 11h gap', () => {
            const emp = makeEmployee('e1', []);
            // Shift ends Monday 16:00, next starts Wednesday 09:00 = 41h gap
            const prevShift = makeShift('s-prev', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z');
            const nextShift = makeShift('s-next', '2026-03-11T09:00:00Z', '2026-03-11T17:00:00Z');
            const assigned = new Map([['e1', [prevShift]]]);

            const result = validator.validate('s-next', 'e1', [emp], [prevShift, nextShift], assigned, NO_RULES);
            expect(result.valid).toBe(true);
        });
    });
});
