import { FairnessPolicy } from '../../../src/domain/policies/fairness.policy';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';

/**
 * 🧪 UNIT TEST: FairnessPolicy
 *
 * FairnessPolicy determina si agregar un nuevo turno respeta el límite
 * de horas semanales de un empleado.
 */
describe('FairnessPolicy', () => {

    const makeShift = (durationHours: number, id = 'shift'): Shift => {
        const start = new Date(2024, 0, 15, 8, 0, 0);
        const end = new Date(2024, 0, 15, 8 + durationHours, 0, 0);
        return Shift.fromPersistence({
            id, companyId: 'company-1',
            startTime: start, endTime: end,
            requiredSkillId: null,
            requiredSkillLevel: 'junior',
            requiredExperienceMonths: 0,
            demandScore: DemandWeight.create(5),
            undesirableWeight: UndesirableWeight.create(0),
        });
    };

    // ─── isAssignmentFair() ───────────────────────────────────────────────────
    describe('isAssignmentFair()', () => {

        it('should return true when there is no history and the shift is within limit', () => {
            const policy = new FairnessPolicy(40);
            const candidateShift = makeShift(8);

            expect(policy.isAssignmentFair(candidateShift, [])).toBe(true);
        });

        it('should return true when the total is exactly at the limit (boundary)', () => {
            // Historial: 32h + candidato 8h = 40h exacto → JUSTO (<=)
            const policy = new FairnessPolicy(40);
            const historicalShifts = [
                makeShift(8, 'h1'),
                makeShift(8, 'h2'),
                makeShift(8, 'h3'),
                makeShift(8, 'h4'),
            ];
            const candidateShift = makeShift(8);

            expect(policy.isAssignmentFair(candidateShift, historicalShifts)).toBe(true);
        });

        it('should return false when adding the shift would exceed the limit', () => {
            // Historial: 36h + candidato 8h = 44h > 40h → NO JUSTO
            const policy = new FairnessPolicy(40);
            const historicalShifts = [
                makeShift(8, 'h1'),
                makeShift(8, 'h2'),
                makeShift(8, 'h3'),
                makeShift(12, 'h4'),
            ];
            const candidateShift = makeShift(8);

            expect(policy.isAssignmentFair(candidateShift, historicalShifts)).toBe(false);
        });

        it('should return false when candidate alone exceeds the limit', () => {
            // Sin historial, pero el turno tiene 48h → excede límite de 40h
            const policy = new FairnessPolicy(40);
            const massiveShift = makeShift(48);

            expect(policy.isAssignmentFair(massiveShift, [])).toBe(false);
        });

        it('should work with different max hours limits (e.g. 48h for overtime contract)', () => {
            const policy = new FairnessPolicy(48);
            const historicalShifts = [makeShift(8), makeShift(8)];
            const candidateShift = makeShift(8);

            // 24h historiales + 8h = 32h < 48h → justo
            expect(policy.isAssignmentFair(candidateShift, historicalShifts)).toBe(true);
        });

        it('should be accurate with decimal-hour shifts (39h + 1h = 40h exact boundary)', () => {
            // 39h historial + 1h candidato = 40h exacto → justo
            const policy = new FairnessPolicy(40);
            const mainShift = makeShift(35);
            const extraShift = makeShift(4);
            const candidateShift = makeShift(1);

            expect(policy.isAssignmentFair(candidateShift, [mainShift, extraShift])).toBe(true);
        });
    });
});
