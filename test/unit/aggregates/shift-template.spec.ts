import { ShiftTemplate } from '../../../src/domain/aggregates/shift-template.aggregate';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTemplate(
  dayOfWeek: number,
  startTime: string,
  endTime: string,
): ShiftTemplate {
  return ShiftTemplate.create({
    id: 'tpl-1',
    companyId: 'company-1',
    name: `Test template ${dayOfWeek}`,
    dayOfWeek,
    startTime,
    endTime,
    requiredSkillId: null,
    requiredSkillLevel: 'junior',
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.create(2),
    undesirableWeight: UndesirableWeight.create(0),
    isActive: true,
  });
}

/** 2024-03-04 is a Monday. Anchoring tests to this well-known date. */
const WEEK_MONDAY = new Date('2024-03-04T00:00:00Z');

// Weekday index → expected UTC date string for the week of 2024-03-04
const EXPECTED_DATE: Record<number, string> = {
  0: '2024-03-10', // Sunday  (+6 from Monday)
  1: '2024-03-04', // Monday  (+0)
  2: '2024-03-05', // Tuesday (+1)
  3: '2024-03-06', // Wednesday (+2)
  4: '2024-03-07', // Thursday (+3)
  5: '2024-03-08', // Friday   (+4)
  6: '2024-03-09', // Saturday (+5)
};

// ─── ShiftTemplate.instantiateForWeek() ───────────────────────────────────────

describe('ShiftTemplate.instantiateForWeek()', () => {
  it('should throw when dayOfWeek is invalid', () => {
    expect(() => makeTemplate(7, '08:00', '16:00')).toThrow(
      'Invalid dayOfWeek',
    );
    expect(() => makeTemplate(-1, '08:00', '16:00')).toThrow(
      'Invalid dayOfWeek',
    );
  });

  it('should preserve the template id in templateId field of produced Shift', () => {
    const tpl = makeTemplate(1, '08:00', '16:00');
    const shift = tpl.instantiateForWeek(WEEK_MONDAY);
    expect(shift.templateId).toBe('tpl-1');
  });

  // ── One test per day of week ──────────────────────────────────────────────

  for (const [dayStr, expectedDate] of Object.entries(EXPECTED_DATE)) {
    const day = Number(dayStr);
    it(`should produce a Shift on ${expectedDate} (dayOfWeek=${day})`, () => {
      const tpl = makeTemplate(day, '09:00', '17:00');
      const shift = tpl.instantiateForWeek(WEEK_MONDAY);

      const actualDate = shift.startTime.toISOString().split('T')[0];
      expect(actualDate).toBe(expectedDate);
    });
  }

  it('should set correct start/end hours from startTime/endTime strings', () => {
    const tpl = makeTemplate(1, '08:00', '16:00'); // Monday morning
    const shift = tpl.instantiateForWeek(WEEK_MONDAY);

    expect(shift.startTime.getUTCHours()).toBe(8);
    expect(shift.endTime.getUTCHours()).toBe(16);
  });

  it('should produce a valid Shift (endTime > startTime)', () => {
    const tpl = makeTemplate(2, '14:00', '22:00'); // Tuesday evening
    const shift = tpl.instantiateForWeek(WEEK_MONDAY);

    expect(shift.endTime.getTime()).toBeGreaterThan(shift.startTime.getTime());
  });

  it('should handle midnight end (23:59 → next-day 00:00)', () => {
    const tpl = makeTemplate(1, '16:00', '23:59'); // Evening to midnight
    const shift = tpl.instantiateForWeek(WEEK_MONDAY);

    // End time must be on next day 00:00
    expect(shift.endTime.getUTCDate()).toBe(shift.startTime.getUTCDate() + 1);
    expect(shift.endTime.getUTCHours()).toBe(0);
    expect(shift.endTime.getUTCMinutes()).toBe(0);
  });

  it('each call produces a Shift with a fresh UUID', () => {
    const tpl = makeTemplate(1, '08:00', '16:00');
    const shift1 = tpl.instantiateForWeek(WEEK_MONDAY);
    const shift2 = tpl.instantiateForWeek(WEEK_MONDAY);
    expect(shift1.id).not.toBe(shift2.id);
  });

  it('deactivate() returns an inactive template without mutating original', () => {
    const tpl = makeTemplate(1, '08:00', '16:00');
    const deactivated = tpl.deactivate();

    expect(tpl.isActive).toBe(true);
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.id).toBe(tpl.id); // same identity
  });
});
