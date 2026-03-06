import { FairnessScore } from '../../../src/domain/value-objects/fairness-score.vo';

/**
 * 🧪 UNIT TEST: FairnessScore Value Object
 *
 * FairnessScore es un VO con rango 0–1000 (ampliado para acumulación semanal).
 * Constructor privado — se crea via FairnessScore.create()
 */
describe('FairnessScore Value Object', () => {

    describe('create()', () => {

        // ─── Valores válidos ──────────────────────────────────────────────────
        it('should create with score of 0 (minimum boundary)', () => {
            const score = FairnessScore.create(0);
            expect(score.value).toBe(0);
        });

        it('should create with score of 1000 (maximum boundary)', () => {
            const score = FairnessScore.create(1000);
            expect(score.value).toBe(1000);
        });

        it('should create with score of 500 (midpoint)', () => {
            const score = FairnessScore.create(500);
            expect(score.value).toBe(500);
        });

        it('should create with decimal score within bounds (e.g. 75.5)', () => {
            const score = FairnessScore.create(75.5);
            expect(score.value).toBe(75.5);
        });

        // ─── Valores inválidos ────────────────────────────────────────────────
        it('should throw when score is negative (-1)', () => {
            expect(() => FairnessScore.create(-1))
                .toThrow();
        });

        it('should throw when score exceeds 1000 (1001)', () => {
            expect(() => FairnessScore.create(1001))
                .toThrow();
        });

        it('should throw when score is very negative (-9999)', () => {
            expect(() => FairnessScore.create(-9999))
                .toThrow();
        });

        it('should throw when score is very high (9999)', () => {
            expect(() => FairnessScore.create(9999))
                .toThrow();
        });
    });

    describe('add() / subtract()', () => {
        it('should add two scores', () => {
            const a = FairnessScore.create(100);
            const b = FairnessScore.create(200);
            expect(a.add(b).value).toBe(300);
        });

        it('should clamp add at MAX (1000)', () => {
            const a = FairnessScore.create(900);
            const b = FairnessScore.create(200);
            expect(a.add(b).value).toBe(1000);
        });

        it('should subtract two scores', () => {
            const a = FairnessScore.create(500);
            const b = FairnessScore.create(100);
            expect(a.subtract(b).value).toBe(400);
        });

        it('should clamp subtract at MIN (0)', () => {
            const a = FairnessScore.create(50);
            const b = FairnessScore.create(100);
            expect(a.subtract(b).value).toBe(0);
        });
    });
});
