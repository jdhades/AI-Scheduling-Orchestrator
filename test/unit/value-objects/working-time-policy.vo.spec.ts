import { WorkingTimePolicyVO } from '../../../src/domain/value-objects/working-time-policy.vo';

describe('WorkingTimePolicyVO', () => {
  describe('create()', () => {
    it('accepts valid values', () => {
      const p = WorkingTimePolicyVO.create({
        maxHoursPerDay: 8,
        maxHoursPerWeek: 40,
      });
      expect(p.maxHoursPerDay).toBe(8);
      expect(p.maxHoursPerWeek).toBe(40);
    });

    it('accepts decimal values', () => {
      const p = WorkingTimePolicyVO.create({
        maxHoursPerDay: 7.5,
        maxHoursPerWeek: 37.5,
      });
      expect(p.maxHoursPerDay).toBe(7.5);
    });

    it('rejects maxHoursPerDay <= 0', () => {
      expect(() =>
        WorkingTimePolicyVO.create({
          maxHoursPerDay: 0,
          maxHoursPerWeek: 40,
        }),
      ).toThrow(/maxHoursPerDay/);
    });

    it('rejects maxHoursPerDay > 24', () => {
      expect(() =>
        WorkingTimePolicyVO.create({
          maxHoursPerDay: 25,
          maxHoursPerWeek: 40,
        }),
      ).toThrow(/maxHoursPerDay/);
    });

    it('rejects maxHoursPerWeek > 168', () => {
      expect(() =>
        WorkingTimePolicyVO.create({
          maxHoursPerDay: 8,
          maxHoursPerWeek: 200,
        }),
      ).toThrow(/maxHoursPerWeek/);
    });
  });

  describe('describe()', () => {
    it('returns a human-readable string', () => {
      const p = WorkingTimePolicyVO.create({
        maxHoursPerDay: 6,
        maxHoursPerWeek: 24,
      });
      expect(p.describe()).toBe('max 6h/día, 24h/semana');
    });
  });
});
