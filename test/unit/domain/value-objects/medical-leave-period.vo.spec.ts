import { MedicalLeavePeriod } from '../../../../src/domain/value-objects/medical-leave-period.vo';
import { DomainError } from '../../../../src/domain/errors/domain.error';

describe('MedicalLeavePeriod Value Object', () => {
  it('should create a valid MedicalLeavePeriod and calculate duration', () => {
    const startDate = new Date('2026-03-01T00:00:00Z');
    const endDate = new Date('2026-03-05T00:00:00Z');

    const period = MedicalLeavePeriod.create(startDate, endDate);

    expect(period.startDate).toBe(startDate);
    expect(period.endDate).toBe(endDate);
    expect(period.durationDays).toBe(5); // 1st to 5th inclusive = 5 days
  });

  it('should allow single-day leave (start and end date are same)', () => {
    const date = new Date('2026-03-10T00:00:00Z');
    const period = MedicalLeavePeriod.create(date, date);

    expect(period.durationDays).toBe(1);
  });

  it('should throw DomainError if endDate is before startDate', () => {
    const startDate = new Date('2026-03-05T00:00:00Z');
    const endDate = new Date('2026-03-01T00:00:00Z');

    expect(() => MedicalLeavePeriod.create(startDate, endDate)).toThrow(
      DomainError,
    );
  });

  it('should correctly compare equality', () => {
    const d1 = new Date('2026-03-01T00:00:00Z');
    const d2 = new Date('2026-03-02T00:00:00Z');

    const period1 = MedicalLeavePeriod.create(d1, d2);
    const period2 = MedicalLeavePeriod.create(
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-02T00:00:00Z'),
    );
    const period3 = MedicalLeavePeriod.create(d1, d1);

    expect(period1.equals(period2)).toBe(true);
    expect(period1.equals(period3)).toBe(false);
  });
});
