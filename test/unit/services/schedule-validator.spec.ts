import {
  ScheduleValidatorService,
  type BusyAssignment,
} from '../../../src/domain/services/schedule-validator.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { CompanySkill } from '../../../src/domain/aggregates/company-skill.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { SkillValidationPolicy } from '../../../src/domain/policies/skill-validation.policy';

function makeEmployee(id: string, skillId?: string): Employee {
  const emp = Employee.fromPersistence({
    id,
    companyId: 'company-1',
    name: 'Test Name',
    role: 'Test Role',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, {
      junior: 6,
      intermediate: 24,
      senior: 999,
    }),
  });

  if (skillId) {
    const skill = CompanySkill.create({
      id: skillId,
      name: 'Enfermería',
      companyId: 'company-1',
      level: 'junior',
      requiredExperienceMonths: 0,
      certificationExpiration: null,
    });
    emp.assignSkill(skill, new SkillValidationPolicy());
  }
  return emp;
}

function makeSlot(
  templateId: string,
  requiredSkillId: string | null,
  startHour = 8,
  endHour = 16,
  offsetDays = 0,
): VirtualShiftSlot {
  const base = new Date('2026-03-04T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + offsetDays);
  const dateISO = base.toISOString().split('T')[0];
  const start = new Date(base);
  start.setUTCHours(startHour, 0, 0, 0);
  const end = new Date(base);
  end.setUTCHours(endHour, 0, 0, 0);
  return VirtualShiftSlot.create({
    templateId,
    companyId: 'company-1',
    date: dateISO,
    startTime: start,
    endTime: end,
    templateName: templateId,
    requiredSkillId,
  });
}

function busyFromSlot(slot: VirtualShiftSlot): BusyAssignment {
  return {
    slotKey: slot.slotKey,
    startTime: slot.startTime,
    endTime: slot.endTime,
    overlapsWith: (other) => slot.overlapsWith(other),
  };
}

const NO_RULES: any[] = [];

describe('ScheduleValidatorService', () => {
  let validator: ScheduleValidatorService;
  let busy: Map<string, BusyAssignment[]>;

  beforeEach(() => {
    validator = new ScheduleValidatorService();
    busy = new Map();
  });

  it('returns valid when employee exists, has skill, no overlap', () => {
    const emp = makeEmployee('e1', 'skill-nurse');
    const slot = makeSlot('s1', 'skill-nurse');
    busy.set('e1', []);

    const result = validator.validate(
      slot.slotKey,
      'e1',
      [emp],
      [slot],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('invalid when employee does not exist', () => {
    const slot = makeSlot('s1', null);
    const result = validator.validate(
      slot.slotKey,
      'NON',
      [makeEmployee('e1')],
      [slot],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('not found in current employee pool');
  });

  it('invalid when slot does not exist', () => {
    const emp = makeEmployee('e1');
    busy.set('e1', []);
    const result = validator.validate(
      'nonexistent|2026-03-04',
      'e1',
      [emp],
      [],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('not found in current slot list');
  });

  it('invalid when employee lacks required skill', () => {
    const emp = makeEmployee('e1');
    const slot = makeSlot('s1', 'skill-nurse');
    busy.set('e1', []);
    const result = validator.validate(
      slot.slotKey,
      'e1',
      [emp],
      [slot],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('lacks required skill');
  });

  it('valid when slot has no required skill', () => {
    const emp = makeEmployee('e1');
    const slot = makeSlot('s1', null);
    busy.set('e1', []);
    const result = validator.validate(
      slot.slotKey,
      'e1',
      [emp],
      [slot],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(true);
  });

  it('invalid when overlapping with already-busy slot', () => {
    const emp = makeEmployee('e1');
    const slot1 = makeSlot('s1', null, 8, 16);
    const slot2 = makeSlot('s2', null, 12, 20);
    busy.set('e1', [busyFromSlot(slot1)]);
    const result = validator.validate(
      slot2.slotKey,
      'e1',
      [emp],
      [slot1, slot2],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('overlapping slot');
  });

  it('valid when slots are on different days and one-per-day holds', () => {
    const emp = makeEmployee('e1');
    const slot1 = makeSlot('s1', null, 8, 16, 0);
    const slot2 = makeSlot('s2', null, 4, 12, 1);
    busy.set('e1', [busyFromSlot(slot1)]);
    const result = validator.validate(
      slot2.slotKey,
      'e1',
      [emp],
      [slot1, slot2],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(true);
  });

  it('short-circuits with one violation when employee and slot both missing', () => {
    const result = validator.validate(
      'ghost|2026-03-04',
      'NON',
      [],
      [],
      busy,
      NO_RULES,
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it('isAvailable() true when no busy slots', () => {
    const emp = makeEmployee('e1');
    const slot = makeSlot('s1', null);
    busy.set('e1', []);
    expect(validator.isAvailable(emp, slot, busy)).toBe(true);
  });

  it('isAvailable() false when overlapping slot exists', () => {
    const emp = makeEmployee('e1');
    const slot1 = makeSlot('s1', null, 8, 16);
    const slot2 = makeSlot('s2', null, 14, 22);
    busy.set('e1', [busyFromSlot(slot1)]);
    expect(validator.isAvailable(emp, slot2, busy)).toBe(false);
  });

  describe('hard semantic constraints', () => {
    it('rejects when slot is blocked for all employees', () => {
      const emp = makeEmployee('e1');
      const slot = makeSlot('s1', null);
      busy.set('e1', []);
      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        busy,
        [{ rule: 'Feriado', weight: 2, employeeId: '*', shiftId: slot.slotKey }],
      );
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes('blocked for all'))).toBe(true);
    });

    it('rejects when employee is specifically blocked from slot', () => {
      const emp = makeEmployee('e1');
      const slot = makeSlot('s1', null);
      busy.set('e1', []);
      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        busy,
        [{ rule: 'Día libre', weight: 2, employeeId: 'e1', shiftId: slot.slotKey }],
      );
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes('blocked from slot'))).toBe(true);
    });

    it('allows assignment when a different employee is blocked', () => {
      const emp = makeEmployee('e1', 'skill-nurse');
      const slot = makeSlot('s1', 'skill-nurse');
      busy.set('e1', []);
      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        busy,
        [{ rule: 'Otro', weight: 2, employeeId: 'e2', shiftId: slot.slotKey }],
      );
      expect(result.valid).toBe(true);
    });

    it('ignores soft constraints (weight=1) in hard validation', () => {
      const emp = makeEmployee('e1', 'skill-nurse');
      const slot = makeSlot('s1', 'skill-nurse');
      busy.set('e1', []);
      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        busy,
        [{ rule: 'Prefer no', weight: 1, employeeId: 'e1', shiftId: slot.slotKey }],
      );
      expect(result.valid).toBe(true);
    });
  });
});
