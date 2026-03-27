import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';
import { EmployeePreference } from '../../../src/domain/value-objects/employee-preference.vo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RANGES = { junior: 6, intermediate: 24, senior: 999 };

function makeEmployee(
  customAvailability?: EmployeeAvailability[],
  customPreferences?: EmployeePreference[],
): Employee {
  return Employee.fromPersistence({
    id: 'emp-1',
    companyId: 'company-1',
    name: 'Ana García',
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, RANGES),
    availability: customAvailability,
    preferences: customPreferences,
  });
}

/** UTC date for a given day-of-week and hour, anchored to week 2026-W11 (Mon=2026-03-09) */
function utcDate(dayOffset: number, hour: number): Date {
  // 2026-03-09 is a Monday (dayOfWeek=1)
  const d = new Date(`2026-03-09T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

// ─── EmployeeAvailability VO ──────────────────────────────────────────────────

describe('EmployeeAvailability Value Object', () => {
  it('should throw if dayOfWeek is out of range', () => {
    expect(() => new EmployeeAvailability('id', 7, '09:00', '17:00')).toThrow();
    expect(
      () => new EmployeeAvailability('id', -1, '09:00', '17:00'),
    ).toThrow();
  });

  it('coversShift() → true when shift day and times fall within window', () => {
    // Monday (dayOfWeek=1) 09:00–17:00 window
    const availability = new EmployeeAvailability(
      'avail-1',
      1,
      '09:00',
      '17:00',
    );
    const start = utcDate(0, 9); // Monday 09:00 UTC
    const end = utcDate(0, 17); // Monday 17:00 UTC
    expect(availability.coversShift(start, end)).toBe(true);
  });

  it('coversShift() → false when shift is on a different day', () => {
    // Window is Monday, shift is Tuesday
    const availability = new EmployeeAvailability(
      'avail-1',
      1,
      '09:00',
      '17:00',
    );
    const start = utcDate(1, 9); // Tuesday 09:00 UTC
    const end = utcDate(1, 17); // Tuesday 17:00 UTC
    expect(availability.coversShift(start, end)).toBe(false);
  });

  it('coversShift() → false when shift starts before window opens', () => {
    const availability = new EmployeeAvailability(
      'avail-1',
      1,
      '09:00',
      '17:00',
    );
    const start = utcDate(0, 7); // 07:00 — before window
    const end = utcDate(0, 15);
    expect(availability.coversShift(start, end)).toBe(false);
  });

  it('coversShift() → false when shift ends after window closes', () => {
    const availability = new EmployeeAvailability(
      'avail-1',
      1,
      '09:00',
      '17:00',
    );
    const start = utcDate(0, 10);
    const end = utcDate(0, 18); // 18:00 — after window
    expect(availability.coversShift(start, end)).toBe(false);
  });
});

// ─── Employee.isAvailable() ───────────────────────────────────────────────────

describe('Employee.isAvailable()', () => {
  it('should return true when no availability windows are defined (always available)', () => {
    const emp = makeEmployee([]); // empty = no restriction
    expect(emp.isAvailable(utcDate(0, 9), utcDate(0, 17))).toBe(true);
  });

  it('should return true when a matching window exists', () => {
    const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
    const emp = makeEmployee([mondayWindow]);
    expect(emp.isAvailable(utcDate(0, 9), utcDate(0, 17))).toBe(true);
  });

  it('should return false when no window covers the shift', () => {
    const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
    const emp = makeEmployee([mondayWindow]);
    // Shift on Tuesday — no window
    expect(emp.isAvailable(utcDate(1, 9), utcDate(1, 17))).toBe(false);
  });

  it('should return true when at least one of multiple windows covers the shift', () => {
    const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
    const wednesdayWindow = new EmployeeAvailability('a2', 3, '09:00', '17:00');
    const emp = makeEmployee([mondayWindow, wednesdayWindow]);
    // Wednesday shift
    expect(emp.isAvailable(utcDate(2, 9), utcDate(2, 17))).toBe(true);
  });
});

// ─── EmployeePreference VO ────────────────────────────────────────────────────

describe('EmployeePreference Value Object', () => {
  it('should throw when weight is out of range (1–5)', () => {
    expect(() => new EmployeePreference('id', 'PREFERS_MORNING', 0)).toThrow();
    expect(() => new EmployeePreference('id', 'PREFERS_MORNING', 6)).toThrow();
  });

  it('PREFERS_MORNING: multiplier < 1 for morning shift, = 1 for evening', () => {
    const pref = new EmployeePreference('p1', 'PREFERS_MORNING', 3);
    const morningStart = new Date('2026-03-09T09:00:00Z'); // 09:00 = morning
    const eveningStart = new Date('2026-03-09T15:00:00Z'); // 15:00 = evening
    expect(pref.getCostMultiplier(morningStart)).toBeLessThan(1);
    expect(pref.getCostMultiplier(eveningStart)).toBe(1);
  });

  it('AVOID_WEEKENDS: multiplier > 1 for weekend, = 1 for weekday', () => {
    const pref = new EmployeePreference('p2', 'AVOID_WEEKENDS', 2);
    const saturday = new Date('2026-03-14T09:00:00Z'); // Saturday
    const monday = new Date('2026-03-09T09:00:00Z'); // Monday
    expect(pref.getCostMultiplier(saturday)).toBeGreaterThan(1);
    expect(pref.getCostMultiplier(monday)).toBe(1);
  });

  it('PREFERS_WEEKENDS: multiplier < 1 for weekend', () => {
    const pref = new EmployeePreference('p3', 'PREFERS_WEEKENDS', 4);
    const saturday = new Date('2026-03-14T09:00:00Z');
    expect(pref.getCostMultiplier(saturday)).toBeLessThan(1);
  });
});

// ─── Employee.getPreferenceMultiplier() ───────────────────────────────────────

describe('Employee.getPreferenceMultiplier()', () => {
  it('should return 1.0 when employee has no preferences', () => {
    const emp = makeEmployee([], []);
    const shift = new Date('2026-03-09T09:00:00Z');
    expect(emp.getPreferenceMultiplier(shift)).toBe(1.0);
  });

  it('should compound multiple preference multipliers', () => {
    const prefMorning = new EmployeePreference('p1', 'PREFERS_MORNING', 2);
    const prefWeekends = new EmployeePreference('p2', 'AVOID_WEEKENDS', 1);
    const emp = makeEmployee([], [prefMorning, prefWeekends]);

    // Monday morning: PREFERS_MORNING applies (< 1), AVOID_WEEKENDS = 1
    const mondayMorning = new Date('2026-03-09T09:00:00Z');
    const multiplier = emp.getPreferenceMultiplier(mondayMorning);
    expect(multiplier).toBeLessThan(1); // bonus for morning preference
  });
});
