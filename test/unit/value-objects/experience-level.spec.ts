import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';

/**
 * 🧪 UNIT TEST: ExperienceLevel Value Object
 *
 * Usamos un rango fijo para los tests:
 *  - Junior:        0  - 5  meses
 *  - Intermediate:  6  - 23 meses
 *  - Senior:        24+    meses
 */
describe('ExperienceLevel Value Object', () => {
  // Rango de referencia compartido por todos los tests del archivo
  const RANGES = { junior: 6, intermediate: 24, senior: 999 };

  describe('constructor', () => {
    it('should create with 0 months (edge case: no experience)', () => {
      const level = new ExperienceLevel(0, RANGES);
      expect(level.months).toBe(0);
    });

    it('should throw when months is negative', () => {
      expect(() => new ExperienceLevel(-1, RANGES)).toThrow(
        'Experience cannot be negative',
      );
    });
  });

  describe('isJunior()', () => {
    it('should return true when months is below the junior threshold', () => {
      const level = new ExperienceLevel(3, RANGES);
      expect(level.isJunior()).toBe(true);
    });

    it('should return true at 0 months', () => {
      const level = new ExperienceLevel(0, RANGES);
      expect(level.isJunior()).toBe(true);
    });

    it('should return false when months equals the junior threshold', () => {
      // 6 meses ya NO es junior (usa >=)
      const level = new ExperienceLevel(6, RANGES);
      expect(level.isJunior()).toBe(false);
    });
  });

  describe('isIntermediate()', () => {
    it('should return true when months is exactly at junior threshold', () => {
      const level = new ExperienceLevel(6, RANGES);
      expect(level.isIntermediate()).toBe(true);
    });

    it('should return true in the middle of the intermediate range', () => {
      const level = new ExperienceLevel(12, RANGES);
      expect(level.isIntermediate()).toBe(true);
    });

    it('should return false for junior months (below junior threshold)', () => {
      const level = new ExperienceLevel(2, RANGES);
      expect(level.isIntermediate()).toBe(false);
    });

    it('should return false when months reaches senior threshold', () => {
      const level = new ExperienceLevel(24, RANGES);
      expect(level.isIntermediate()).toBe(false);
    });
  });

  describe('isSenior()', () => {
    it('should return true when months equals the intermediate threshold', () => {
      const level = new ExperienceLevel(24, RANGES);
      expect(level.isSenior()).toBe(true);
    });

    it('should return true for very high months', () => {
      const level = new ExperienceLevel(120, RANGES);
      expect(level.isSenior()).toBe(true);
    });

    it('should return false for junior months', () => {
      const level = new ExperienceLevel(3, RANGES);
      expect(level.isSenior()).toBe(false);
    });

    it('should return false for intermediate months', () => {
      const level = new ExperienceLevel(12, RANGES);
      expect(level.isSenior()).toBe(false);
    });
  });

  describe('Boundary conditions (niveles adyacentes)', () => {
    it('exactly 5 months → junior, exactly 6 → intermediate', () => {
      const fiveMonths = new ExperienceLevel(5, RANGES);
      const sixMonths = new ExperienceLevel(6, RANGES);

      expect(fiveMonths.isJunior()).toBe(true);
      expect(sixMonths.isJunior()).toBe(false);
      expect(sixMonths.isIntermediate()).toBe(true);
    });

    it('exactly 23 months → intermediate, exactly 24 → senior', () => {
      const twentyThree = new ExperienceLevel(23, RANGES);
      const twentyFour = new ExperienceLevel(24, RANGES);

      expect(twentyThree.isIntermediate()).toBe(true);
      expect(twentyFour.isIntermediate()).toBe(false);
      expect(twentyFour.isSenior()).toBe(true);
    });
  });
});
