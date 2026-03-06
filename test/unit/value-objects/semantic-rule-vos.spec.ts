import { RulePriority } from '../../../src/domain/value-objects/rule-priority.vo';
import { RuleType } from '../../../src/domain/value-objects/rule-type.vo';
import { RuleEmbedding } from '../../../src/domain/value-objects/rule-embedding.vo';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeVector(value = 0.1): number[] {
    return Array(768).fill(value);
}

// ─── RulePriority ─────────────────────────────────────────────────────────────

describe('RulePriority Value Object', () => {

    describe('factory methods', () => {
        it('should create legal priority with value 1', () => {
            const p = RulePriority.legal();
            expect(p.getValue()).toBe(1);
        });

        it('should create semantic priority with value 2', () => {
            const p = RulePriority.semantic();
            expect(p.getValue()).toBe(2);
        });

        it('should create preference priority with value 3', () => {
            const p = RulePriority.preference();
            expect(p.getValue()).toBe(3);
        });

        it('should create from numeric value via create()', () => {
            expect(RulePriority.create(1).getValue()).toBe(1);
            expect(RulePriority.create(2).getValue()).toBe(2);
            expect(RulePriority.create(3).getValue()).toBe(3);
        });

        it('should throw for invalid priority value (0)', () => {
            expect(() => RulePriority.create(0 as 1)).toThrow();
        });

        it('should throw for invalid priority value (4)', () => {
            expect(() => RulePriority.create(4 as 1)).toThrow();
        });
    });

    describe('comparison methods', () => {
        it('legal should be higher than semantic', () => {
            expect(RulePriority.legal().isHigherThan(RulePriority.semantic())).toBe(true);
        });

        it('semantic should be higher than preference', () => {
            expect(RulePriority.semantic().isHigherThan(RulePriority.preference())).toBe(true);
        });

        it('preference should NOT be higher than legal', () => {
            expect(RulePriority.preference().isHigherThan(RulePriority.legal())).toBe(false);
        });

        it('legal should equal legal', () => {
            expect(RulePriority.legal().equals(RulePriority.legal())).toBe(true);
        });

        it('legal should not equal semantic', () => {
            expect(RulePriority.legal().equals(RulePriority.semantic())).toBe(false);
        });
    });

    describe('toLabel()', () => {
        it('should return "legal" for priority 1', () => {
            expect(RulePriority.legal().toLabel()).toBe('legal');
        });

        it('should return "semantic" for priority 2', () => {
            expect(RulePriority.semantic().toLabel()).toBe('semantic');
        });

        it('should return "preference" for priority 3', () => {
            expect(RulePriority.preference().toLabel()).toBe('preference');
        });
    });
});

// ─── RuleType ─────────────────────────────────────────────────────────────────

describe('RuleType Value Object', () => {

    describe('factory create()', () => {
        it('should create restriction type', () => {
            expect(RuleType.create('restriction').getValue()).toBe('restriction');
        });

        it('should create preference type', () => {
            expect(RuleType.create('preference').getValue()).toBe('preference');
        });

        it('should create requirement type', () => {
            expect(RuleType.create('requirement').getValue()).toBe('requirement');
        });

        it('should throw for unknown type', () => {
            expect(() => RuleType.create('unknown' as 'restriction')).toThrow();
        });
    });

    describe('isBlocking()', () => {
        it('restriction should be blocking', () => {
            expect(RuleType.create('restriction').isBlocking()).toBe(true);
        });

        it('requirement should be blocking', () => {
            expect(RuleType.create('requirement').isBlocking()).toBe(true);
        });

        it('preference should NOT be blocking', () => {
            expect(RuleType.create('preference').isBlocking()).toBe(false);
        });
    });

    describe('isRestriction()', () => {
        it('restriction should return true', () => {
            expect(RuleType.create('restriction').isRestriction()).toBe(true);
        });

        it('preference should return false', () => {
            expect(RuleType.create('preference').isRestriction()).toBe(false);
        });
    });

    describe('equals()', () => {
        it('same type should be equal', () => {
            expect(RuleType.create('restriction').equals(RuleType.create('restriction'))).toBe(true);
        });

        it('different types should not be equal', () => {
            expect(RuleType.create('restriction').equals(RuleType.create('preference'))).toBe(false);
        });
    });
});

// ─── RuleEmbedding ────────────────────────────────────────────────────────────

describe('RuleEmbedding Value Object', () => {

    describe('create()', () => {
        it('should create with 768 valid dimensions', () => {
            const emb = RuleEmbedding.create(makeVector());
            expect(emb.getVector()).toHaveLength(768);
        });

        it('should throw for wrong dimension count (less than 768)', () => {
            expect(() => RuleEmbedding.create(Array(700).fill(0.1))).toThrow();
        });

        it('should throw for wrong dimension count (more than 768)', () => {
            expect(() => RuleEmbedding.create(Array(800).fill(0.1))).toThrow();
        });

        it('should throw for empty vector', () => {
            expect(() => RuleEmbedding.create([])).toThrow();
        });

        it('should throw if vector contains NaN', () => {
            const v = makeVector();
            v[0] = NaN;
            expect(() => RuleEmbedding.create(v)).toThrow();
        });

        it('should throw if vector contains Infinity', () => {
            const v = makeVector();
            v[5] = Infinity;
            expect(() => RuleEmbedding.create(v)).toThrow();
        });

        it('should return immutable copy of vector', () => {
            const original = makeVector(0.5);
            const emb = RuleEmbedding.create(original);
            original[0] = 999; // mutate original
            expect(emb.getVector()[0]).toBe(0.5); // should NOT be affected
        });
    });

    describe('toPgVectorString()', () => {
        it('should return bracket-wrapped comma-separated values', () => {
            const v = [0.1, 0.2, ...Array(766).fill(0.0)];
            const emb = RuleEmbedding.create(v);
            const str = emb.toPgVectorString();
            expect(str).toMatch(/^\[.+\]$/);
            expect(str).toContain('0.1');
        });
    });

    describe('cosineSimilarity()', () => {
        it('identical vectors should have similarity = 1', () => {
            const v = makeVector(0.5);
            const a = RuleEmbedding.create(v);
            const b = RuleEmbedding.create(v);
            expect(a.cosineSimilarity(b)).toBeCloseTo(1, 5);
        });

        it('vectors pointing opposite direction should have similarity = -1', () => {
            const pos = makeVector(0.5);
            const neg = makeVector(-0.5);
            const a = RuleEmbedding.create(pos);
            const b = RuleEmbedding.create(neg);
            expect(a.cosineSimilarity(b)).toBeCloseTo(-1, 5);
        });
    });
});
