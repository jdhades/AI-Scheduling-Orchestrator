import { WhatsappHandshake } from '../../../src/domain/aggregates/whatsapp-handshake.aggregate';
import { HandshakeToken } from '../../../src/domain/value-objects/handshake-token.vo';
import { HandshakeInitiatedEvent } from '../../../src/domain/events/handshake-initiated.event';
import { HandshakeVerifiedEvent } from '../../../src/domain/events/handshake-verified.event';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * 🧪 UNIT TEST: WhatsappHandshake Aggregate
 *
 * Testeamos las invariantes del dominio — aquí vive la lógica de negocio real.
 * No hay mocks del dominio: usamos los VOs y eventos reales.
 */
describe('WhatsappHandshake', () => {
  const makeToken = (ttl = 15) => HandshakeToken.create(VALID_UUID, ttl);

  describe('initiate()', () => {
    it('should create a handshake in unverified state', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );
      expect(handshake.isVerified()).toBe(false);
      expect(handshake.isExpired()).toBe(false);
    });

    it('should apply HandshakeInitiatedEvent with correct data', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );
      const events = handshake.getUncommittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(HandshakeInitiatedEvent);

      const event = events[0] as HandshakeInitiatedEvent;
      expect(event.employeeId).toBe('emp-1');
      expect(event.phone).toBe('+12025550100');
      expect(event.token).toBe(VALID_UUID);
    });
  });

  describe('verify()', () => {
    it('should verify successfully with the correct token', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );
      handshake.getUncommittedEvents(); // flush initiate event

      handshake.verify(VALID_UUID);
      expect(handshake.isVerified()).toBe(true);
    });

    it('should apply HandshakeVerifiedEvent on success', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );

      handshake.verify(VALID_UUID);

      // getUncommittedEvents() acumula todos los eventos (initiate + verified)
      const events = handshake.getUncommittedEvents();
      expect(events).toHaveLength(2);
      expect(events[1]).toBeInstanceOf(HandshakeVerifiedEvent);

      const event = events[1] as HandshakeVerifiedEvent;
      expect(event.employeeId).toBe('emp-1');
      expect(event.phone).toBe('+12025550100');
    });

    it('should throw when token is invalid', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );
      expect(() => handshake.verify('wrong-token')).toThrow(
        'Invalid handshake token',
      );
    });

    it('should throw when token is expired', () => {
      const token = HandshakeToken.create(VALID_UUID, 0);
      // Avanzamos el reloj para forzar expiración
      jest.spyOn(Date, 'now').mockReturnValue(token.expiresAt.getTime() + 1);

      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        token,
      );

      expect(() => handshake.verify(VALID_UUID)).toThrow(
        'Handshake token has expired',
      );

      jest.spyOn(Date, 'now').mockRestore();
    });

    it('should throw when attempting to verify an already verified handshake', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );
      handshake.verify(VALID_UUID); // primera vez: ok

      // segunda vez: debe fallar
      expect(() => handshake.verify(VALID_UUID)).toThrow(
        'Handshake already verified',
      );
    });

    it('should not apply any event when verification fails', () => {
      const handshake = WhatsappHandshake.initiate(
        'hs-1',
        'emp-1',
        '+12025550100',
        makeToken(),
      );

      // Antes de intentar verificar: solo el HandshakeInitiatedEvent
      expect(handshake.getUncommittedEvents()).toHaveLength(1);

      try {
        handshake.verify('bad-token');
      } catch {
        /* expected */
      }

      // Después del fallo: sigue siendo 1 (no se agregó HandshakeVerifiedEvent)
      expect(handshake.getUncommittedEvents()).toHaveLength(1);
    });
  });
});
