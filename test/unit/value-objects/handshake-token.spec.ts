import { HandshakeToken } from '../../../src/domain/value-objects/handshake-token.vo';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('HandshakeToken', () => {
  describe('create()', () => {
    it('should create a valid token with default TTL of 15 minutes', () => {
      const before = Date.now();
      const token = HandshakeToken.create(VALID_UUID);
      const after = Date.now();

      expect(token.value).toBe(VALID_UUID);
      // expiresAt debe estar entre before+15min y after+15min
      const expectedMin = before + 15 * 60 * 1000;
      const expectedMax = after + 15 * 60 * 1000;
      expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(token.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
    });

    it('should create a token with custom TTL', () => {
      const before = Date.now();
      const token = HandshakeToken.create(VALID_UUID, 30);
      const expectedMin = before + 30 * 60 * 1000;
      expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    });

    it('should throw if token is not a valid UUID v4', () => {
      expect(() => HandshakeToken.create('not-a-uuid')).toThrow(
        'HandshakeToken must be a valid UUID v4',
      );
    });

    it('should throw if token is empty', () => {
      expect(() => HandshakeToken.create('')).toThrow(
        'HandshakeToken must be a valid UUID v4',
      );
    });

    it('should throw for UUID v1 (not v4)', () => {
      // UUID v1 — el tercer bloque no empieza con 4
      expect(() =>
        HandshakeToken.create('550e8400-e29b-11d4-a716-446655440000'),
      ).toThrow('HandshakeToken must be a valid UUID v4');
    });
  });

  describe('isExpired()', () => {
    it('should return false for a freshly created token', () => {
      const token = HandshakeToken.create(VALID_UUID);
      expect(token.isExpired()).toBe(false);
    });

    it('should return true for a token with TTL of 0 minutes (already past)', () => {
      // TTL = 0 → expira inmediatamente (ms de diferencia)
      const token = HandshakeToken.create(VALID_UUID, 0);
      // Esperamos 1ms para asegurar que expiró
      const expiredAt = token.expiresAt.getTime();
      jest.spyOn(Date, 'now').mockReturnValue(expiredAt + 1);
      expect(token.isExpired()).toBe(true);
      jest.spyOn(Date, 'now').mockRestore();
    });
  });

  describe('equals()', () => {
    it('should return true for tokens with the same UUID', () => {
      const t1 = HandshakeToken.create(VALID_UUID);
      const t2 = HandshakeToken.create(VALID_UUID);
      expect(t1.equals(t2)).toBe(true);
    });

    it('should return false for tokens with different UUIDs', () => {
      const t1 = HandshakeToken.create(VALID_UUID);
      const t2 = HandshakeToken.create('6ba7b810-9dad-41d1-80b4-00c04fd430c8');
      expect(t1.equals(t2)).toBe(false);
    });
  });
});
