import { ConversationSessionVO } from '../../../src/domain/value-objects/conversation-session.vo';
import { DomainError } from '../../../src/domain/errors/domain.error';

describe('ConversationSessionVO', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('create()', () => {
    it('should create a valid session with correct TTL', () => {
      const now = new Date('2026-03-05T12:00:00.000Z');
      jest.setSystemTime(now);

      const session = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'company-abc',
      });

      expect(session.getEmployeePhone()).toBe('+1234567890');
      expect(session.getCompanyId()).toBe('company-abc');
      expect(session.getPendingIntent()).toBeNull();
      expect(session.getCollectedEntities()).toEqual({});
      expect(session.getCreatedAt()).toEqual(now);

      const expectedExpiresAt = new Date(
        now.getTime() + ConversationSessionVO.SESSION_TTL_SECONDS * 1000,
      );
      expect(session.getExpiresAt()).toEqual(expectedExpiresAt);
      expect(session.getSessionId()).toBe(`+1234567890-${now.getTime()}`);
    });

    it('should throw DomainError if employeePhone is missing', () => {
      expect(() => {
        ConversationSessionVO.create({
          employeePhone: '',
          companyId: 'company-abc',
        });
      }).toThrow(DomainError);
    });

    it('should throw DomainError if companyId is missing', () => {
      expect(() => {
        ConversationSessionVO.create({
          employeePhone: '+1234567890',
          companyId: '',
        });
      }).toThrow(DomainError);
    });
  });

  describe('isExpired()', () => {
    it('should return false if current time is before expiresAt', () => {
      const now = new Date('2026-03-05T12:00:00.000Z');
      jest.setSystemTime(now);

      const session = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'company-abc',
      });

      // 5 minutes later
      jest.setSystemTime(new Date(now.getTime() + 5 * 60 * 1000));
      expect(session.isExpired()).toBe(false);
    });

    it('should return true if current time is strictly after expiresAt', () => {
      const now = new Date('2026-03-05T12:00:00.000Z');
      jest.setSystemTime(now);

      const session = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'company-abc',
      });

      // 11 minutes later (TTL is 10 min)
      jest.setSystemTime(new Date(now.getTime() + 11 * 60 * 1000));
      expect(session.isExpired()).toBe(true);
    });
  });

  describe('withIntent() (merge entities)', () => {
    it('should return a new session instance with the intent and merged entities', () => {
      const baseSession = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'company-abc',
      });

      const newSession = baseSession.withIntent('swap_shift', {
        targetEmployeePhone: '+0987654321',
      });

      expect(newSession).not.toBe(baseSession); // immutable
      expect(newSession.getPendingIntent()).toBe('swap_shift');
      expect(newSession.getCollectedEntities()).toEqual({
        targetEmployeePhone: '+0987654321',
      });

      // Merge another entity later
      const finalSession = newSession.withIntent('swap_shift', {
        shiftId: 'shift-1',
      });

      expect(finalSession.getPendingIntent()).toBe('swap_shift');
      expect(finalSession.getCollectedEntities()).toEqual({
        targetEmployeePhone: '+0987654321',
        shiftId: 'shift-1',
      });
    });

    it('should overwrite overlapping entities with new values', () => {
      const baseSession = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'company-1',
      }).withIntent('report_absence', { shiftId: 'shift-1', reason: 'Sick' });

      const updatedSession = baseSession.withIntent('report_absence', {
        reason: 'Very sick',
      });

      expect(updatedSession.getCollectedEntities()).toEqual({
        shiftId: 'shift-1',
        reason: 'Very sick',
      });
    });
  });

  describe('toSnapshot() & fromSnapshot()', () => {
    it('should serialize and deserialize preserving all data', () => {
      const now = new Date('2026-03-05T12:00:00.000Z');
      jest.setSystemTime(now);

      const session = ConversationSessionVO.create({
        employeePhone: '+1234567890',
        companyId: 'company-1',
      }).withIntent('request_day_off', { date: '2026-03-10' });

      const snapshotStr = JSON.stringify(session.toSnapshot());
      const snapshotObj = JSON.parse(snapshotStr);

      const restoredSession = ConversationSessionVO.fromSnapshot(snapshotObj);

      expect(restoredSession.getSessionId()).toBe(session.getSessionId());
      expect(restoredSession.getEmployeePhone()).toBe(
        session.getEmployeePhone(),
      );
      expect(restoredSession.getCompanyId()).toBe(session.getCompanyId());
      expect(restoredSession.getPendingIntent()).toBe(
        session.getPendingIntent(),
      );
      expect(restoredSession.getCollectedEntities()).toEqual(
        session.getCollectedEntities(),
      );
      expect(restoredSession.getCreatedAt()).toEqual(session.getCreatedAt());
      expect(restoredSession.getExpiresAt()).toEqual(session.getExpiresAt());
    });
  });
});
