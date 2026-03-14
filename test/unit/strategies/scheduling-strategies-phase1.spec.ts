import { CostOptimizedStrategy } from '../../../src/domain/strategies/cost-optimized.strategy';
import { FairnessOptimizedStrategy } from '../../../src/domain/strategies/fairness-optimized.strategy';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';
import { EmployeePreference } from '../../../src/domain/value-objects/employee-preference.vo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RANGES = { junior: 6, intermediate: 24, senior: 999 };

function makeEmployee(id: string, opts?: {
    experience?: number;
    availability?: EmployeeAvailability[];
    preferences?: EmployeePreference[];
}): Employee {
    return Employee.fromPersistence({
        id,
        companyId: 'company-1',
        name: `Employee ${id}`,
        role: 'employee',
        phoneNumber: PhoneNumber.create('+34612345678'),
        experience: new ExperienceLevel(opts?.experience ?? 12, RANGES),
        availability: opts?.availability,
        preferences: opts?.preferences,
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

// ─── CostOptimizedStrategy — Availability & Gap Filter ────────────────────────

describe('CostOptimizedStrategy — Phase 1 Filters', () => {
    const strategy = new CostOptimizedStrategy();

    it('should NOT assign a shift to an employee who is structurally unavailable', () => {
        // Tuesday only window, but shift is on Wednesday
        const tuesdayOnly = new EmployeeAvailability('a1', 2, '09:00', '17:00');
        const emp = makeEmployee('emp-unavail', { availability: [tuesdayOnly] });

        // Wednesday shift (2026-03-11 = Wednesday)
        const shift = makeShift('s1', '2026-03-11T09:00:00Z', '2026-03-11T17:00:00Z');

        const result = strategy.generate([emp], [shift], []);
        expect(result.assignments).toHaveLength(0);
        expect(result.unfilledShifts).toHaveLength(1);
        expect(result.unfilledShifts[0].id).toBe('s1');
    });

    it('should assign a shift to an available employee', () => {
        // Wednesday window covering the shift
        const wednesdayWindow = new EmployeeAvailability('a2', 3, '09:00', '17:00');
        const emp = makeEmployee('emp-avail', { availability: [wednesdayWindow] });

        const shift = makeShift('s1', '2026-03-11T09:00:00Z', '2026-03-11T17:00:00Z');

        const result = strategy.generate([emp], [shift], []);
        expect(result.assignments).toHaveLength(1);
        expect(result.assignments[0].employeeId).toBe('emp-avail');
    });

    it('should respect max 8h per day — second 8h shift on same day is rejected', () => {
        const emp = makeEmployee('emp-1', { availability: [] });
        // Two non-overlapping 8h shifts on the same day (together = 16h, above cap)
        const shift1 = makeShift('s1', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z');
        const shift2 = makeShift('s2', '2026-03-09T16:00:00Z', '2026-03-10T00:00:00Z'); // ends at midnight next day

        const result = strategy.generate([emp], [shift1, shift2], []);
        // Employee can only take one 8h shift per day
        expect(result.assignments).toHaveLength(1);
        expect(result.unfilledShifts).toHaveLength(1);
    });

    it('should respect max 40h per week — employee maxed out across 5 days', () => {
        const emp = makeEmployee('emp-1', { availability: [] });
        // 5 shifts × 8h = 40h. 6th shift must be rejected.
        const shifts = [
            makeShift('s1', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z'), // Mon
            makeShift('s2', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z'), // Tue
            makeShift('s3', '2026-03-11T08:00:00Z', '2026-03-11T16:00:00Z'), // Wed
            makeShift('s4', '2026-03-12T08:00:00Z', '2026-03-12T16:00:00Z'), // Thu
            makeShift('s5', '2026-03-13T08:00:00Z', '2026-03-13T16:00:00Z'), // Fri
            makeShift('s6', '2026-03-14T08:00:00Z', '2026-03-14T16:00:00Z'), // Sat (over limit)
        ];

        const result = strategy.generate([emp], shifts, []);
        expect(result.assignments).toHaveLength(5);
        expect(result.unfilledShifts).toHaveLength(1);
        expect(result.unfilledShifts[0].id).toBe('s6');
    });
});

// ─── Preference Soft Constraint — Favors Preferred Employee ───────────────────

describe('CostOptimizedStrategy — Preference Soft Constraint', () => {
    const strategy = new CostOptimizedStrategy();

    it('prefers a MORNING employee over a neutral one for a morning shift', () => {
        const morningPref = new EmployeePreference('pref-1', 'PREFERS_MORNING', 5);
        const empPrefersMorning = makeEmployee('emp-morning', {
            experience: 12, // intermediate
            preferences: [morningPref],
        });
        const empNeutral = makeEmployee('emp-neutral', {
            experience: 12, // same seniority
            preferences: [],
        });

        // Morning shift (10:00 UTC)
        const morningShift = makeShift('s-morning', '2026-03-09T10:00:00Z', '2026-03-09T18:00:00Z');

        const result = strategy.generate([empNeutral, empPrefersMorning], [morningShift], []);
        expect(result.assignments).toHaveLength(1);
        // The one who prefers mornings should be assigned (lower effective cost)
        expect(result.assignments[0].employeeId).toBe('emp-morning');
    });
});

// ─── FairnessOptimizedStrategy — Prefers Less-burdened Employee ───────────────

describe('FairnessOptimizedStrategy — Phase 1 Filters', () => {
    const strategy = new FairnessOptimizedStrategy();

    it('should not assign to an unavailable employee (fairness strategy)', () => {
        const mondayOnly = new EmployeeAvailability('a1', 1, '09:00', '17:00');
        const emp = makeEmployee('emp-1', { availability: [mondayOnly] });

        // Tuesday shift — employee is not available
        const tuesdayShift = makeShift('s1', '2026-03-10T09:00:00Z', '2026-03-10T17:00:00Z');

        const result = strategy.generate([emp], [tuesdayShift], []);
        expect(result.assignments).toHaveLength(0);
        expect(result.unfilledShifts[0].id).toBe('s1');
    });
});
