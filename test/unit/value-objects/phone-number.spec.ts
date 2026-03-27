import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';

/**
 * 🧪 UNIT TEST: PhoneNumber Value Object
 *
 * Principios aplicados:
 * - Tests aislados: no tocan red ni DB
 * - One assertion concept per test (OACPT)
 * - Nombres descriptivos tipo: "should [acción] when [condición]"
 * - AAA pattern: Arrange → Act → Assert
 */
describe('PhoneNumber Value Object', () => {
  // ─── Casos felices ────────────────────────────────────────────────────────
  describe('create()', () => {
    it('should create a valid phone number in E.164 format', () => {
      // Arrange
      const validNumber = '+12345678901';

      // Act
      const phoneNumber = PhoneNumber.create(validNumber);

      // Assert
      expect(phoneNumber).toBeInstanceOf(PhoneNumber);
      expect(phoneNumber.value).toBe(validNumber);
    });

    it('should create a phone number with minimum valid digits (2 digits after +)', () => {
      const phoneNumber = PhoneNumber.create('+12');
      expect(phoneNumber.value).toBe('+12');
    });

    it('should create a phone number with maximum valid digits (15 digits total)', () => {
      const phoneNumber = PhoneNumber.create('+123456789012345');
      expect(phoneNumber.value).toBe('+123456789012345');
    });

    // ─── Casos de error ──────────────────────────────────────────────────
    it('should throw when phone number does not start with +', () => {
      expect(() => PhoneNumber.create('12345678901')).toThrow(
        'Invalid phone number',
      );
    });

    it('should throw when phone number is empty string', () => {
      expect(() => PhoneNumber.create('')).toThrow('Invalid phone number');
    });

    it('should throw when phone number is just a plus sign', () => {
      expect(() => PhoneNumber.create('+')).toThrow('Invalid phone number');
    });

    it('should throw when phone number contains letters', () => {
      expect(() => PhoneNumber.create('+1234abc7890')).toThrow(
        'Invalid phone number',
      );
    });

    it('should throw when phone number starts with +0 (country code cannot start with 0)', () => {
      expect(() => PhoneNumber.create('+0123456789')).toThrow(
        'Invalid phone number',
      );
    });

    it('should throw when phone number exceeds 15 digits', () => {
      expect(() => PhoneNumber.create('+1234567890123456')).toThrow(
        'Invalid phone number',
      );
    });
  });

  // ─── Comparación ──────────────────────────────────────────────────────────
  describe('equals()', () => {
    it('should return true for two PhoneNumbers with the same value', () => {
      const phone1 = PhoneNumber.create('+12345678901');
      const phone2 = PhoneNumber.create('+12345678901');
      expect(phone1.equals(phone2)).toBe(true);
    });

    it('should return false for two PhoneNumbers with different values', () => {
      const phone1 = PhoneNumber.create('+12345678901');
      const phone2 = PhoneNumber.create('+19999999999');
      expect(phone1.equals(phone2)).toBe(false);
    });
  });
});
