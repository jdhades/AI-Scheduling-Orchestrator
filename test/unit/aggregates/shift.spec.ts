import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';

/**
 * 🧪 UNIT TEST: Shift Aggregate
 *
 * Shift usa factory Shift.fromPersistence() (constructor privado).
 */
describe('Shift Aggregate', () => {

    const makeDate = (hour: number, minute = 0): Date => {
        return new Date(2024, 0, 15, hour, minute, 0, 0);
    };

    const makeShift = (
        startHour: number,
        endHour: number,
        overrides: Partial<{ id: string; companyId: string }> = {}
    ): Shift => {
        return Shift.fromPersistence({
            id: overrides.id ?? 'shift-1',
            companyId: overrides.companyId ?? 'company-1',
            startTime: makeDate(startHour),
            endTime: makeDate(endHour),
            requiredSkillId: null,
            requiredSkillLevel: 'junior',
            requiredExperienceMonths: 0,
            demandScore: DemandWeight.create(5),
            undesirableWeight: UndesirableWeight.create(0),
        });
    };

    // ─── getDuration() ────────────────────────────────────────────────────────
    describe('getDuration()', () => {
        it('should return 8 hours for a standard 8h shift', () => {
            const shift = makeShift(8, 16);
            expect(shift.getDuration()).toBe(8);
        });

        it('should throw for a zero-duration shift (endTime === startTime — domain invariant)', () => {
            expect(() => Shift.fromPersistence({
                id: 'shift-0', companyId: 'company-1',
                startTime: makeDate(9, 0),
                endTime: makeDate(9, 0), // same time
                requiredSkillId: null,
                requiredSkillLevel: 'junior',
                requiredExperienceMonths: 0,
                demandScore: DemandWeight.create(5),
                undesirableWeight: UndesirableWeight.create(0),
            })).toThrow('Shift endTime must be after startTime');
        });

        it('should return 4.5 hours for a 4.5h shift', () => {
            const shift = Shift.fromPersistence({
                id: 'shift-1', companyId: 'company-1',
                startTime: makeDate(8, 0),
                endTime: makeDate(12, 30),
                requiredSkillId: null,
                requiredSkillLevel: 'junior',
                requiredExperienceMonths: 0,
                demandScore: DemandWeight.create(5),
                undesirableWeight: UndesirableWeight.create(0),
            });
            expect(shift.getDuration()).toBe(4.5);
        });

        it('should return 12 hours for a night shift (08:00 → 20:00)', () => {
            const shift = makeShift(8, 20);
            expect(shift.getDuration()).toBe(12);
        });
    });

    // ─── overlapsWith() ───────────────────────────────────────────────────────
    describe('overlapsWith()', () => {
        it('should detect overlap when shifts share a time window', () => {
            const shift1 = makeShift(8, 16);
            const shift2 = makeShift(12, 20);

            expect(shift1.overlapsWith(shift2)).toBe(true);
            expect(shift2.overlapsWith(shift1)).toBe(true);
        });

        it('should detect overlap when one shift is fully inside another', () => {
            const shift1 = makeShift(8, 20);
            const shift2 = makeShift(10, 14);

            expect(shift1.overlapsWith(shift2)).toBe(true);
        });

        it('should NOT detect overlap for consecutive shifts (end == start)', () => {
            const shift1 = makeShift(8, 16);
            const shift2 = makeShift(16, 24);

            expect(shift1.overlapsWith(shift2)).toBe(false);
        });

        it('should NOT detect overlap for completely separate shifts', () => {
            const shift1 = makeShift(8, 12);
            const shift2 = makeShift(14, 18);

            expect(shift1.overlapsWith(shift2)).toBe(false);
        });
    });

    // ─── isNightShift() / isWeekendShift() ────────────────────────────────────
    describe('isNightShift()', () => {
        it('should return true for a shift starting at 22:00', () => {
            const shift = makeShift(22, 23);
            expect(shift.isNightShift()).toBe(true);
        });

        it('should return false for a day shift (08:00 → 16:00)', () => {
            const shift = makeShift(8, 16);
            expect(shift.isNightShift()).toBe(false);
        });
    });
});
