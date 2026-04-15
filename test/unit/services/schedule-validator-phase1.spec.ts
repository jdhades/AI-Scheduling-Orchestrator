import {
  ScheduleValidatorService,
  type BusyAssignment,
} from '../../../src/domain/services/schedule-validator.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';

const RANGES = { junior: 6, intermediate: 24, senior: 999 };
const NO_RULES: any[] = [];

function makeEmployee(
  id: string,
  availability?: EmployeeAvailability[],
): Employee {
  return Employee.fromPersistence({
    id,
    companyId: 'company-1',
    name: 'Test Employee',
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, RANGES),
    availability,
  });
}

function makeSlot(templateId: string, startIso: string, endIso: string): VirtualShiftSlot {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const date = start.toISOString().split('T')[0];
  return VirtualShiftSlot.create({
    templateId,
    companyId: 'company-1',
    date,
    startTime: start,
    endTime: end,
    templateName: templateId,
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

describe('ScheduleValidatorService — Phase 1 Constraints', () => {
  let validator: ScheduleValidatorService;

  beforeEach(() => {
    validator = new ScheduleValidatorService();
  });

  describe('Structural Availability (Hard Constraint)', () => {
    it('passes when employee has no availability windows (always available)', () => {
      const emp = makeEmployee('e1', []);
      const slot = makeSlot('s1', '2026-03-09T09:00:00Z', '2026-03-09T17:00:00Z');
      const assigned = new Map<string, BusyAssignment[]>([['e1', []]]);

      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        assigned,
        NO_RULES,
      );
      expect(result.valid).toBe(true);
    });

    it('passes when employee has a matching availability window', () => {
      const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
      const emp = makeEmployee('e1', [mondayWindow]);
      const slot = makeSlot('s1', '2026-03-09T09:00:00Z', '2026-03-09T17:00:00Z');
      const assigned = new Map<string, BusyAssignment[]>([['e1', []]]);

      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        assigned,
        NO_RULES,
      );
      expect(result.valid).toBe(true);
    });

    it('fails when slot falls outside all availability windows', () => {
      const mondayWindow = new EmployeeAvailability('a1', 1, '09:00', '17:00');
      const emp = makeEmployee('e1', [mondayWindow]);
      const slot = makeSlot('s1', '2026-03-10T09:00:00Z', '2026-03-10T17:00:00Z'); // Tuesday
      const assigned = new Map<string, BusyAssignment[]>([['e1', []]]);

      const result = validator.validate(
        slot.slotKey,
        'e1',
        [emp],
        [slot],
        assigned,
        NO_RULES,
      );
      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.includes('no availability window')),
      ).toBe(true);
    });
  });

  describe('Minimum Shift Gap — removed (manager decides on residual rest)', () => {
    it('does NOT block when shifts are back-to-back on different days', () => {
      const emp = makeEmployee('e1', []);
      const prev = makeSlot('s-prev', '2026-03-09T14:00:00Z', '2026-03-09T22:00:00Z');
      const next = makeSlot('s-next', '2026-03-10T06:00:00Z', '2026-03-10T14:00:00Z');
      const assigned = new Map<string, BusyAssignment[]>([['e1', [busyFromSlot(prev)]]]);

      const result = validator.validate(
        next.slotKey,
        'e1',
        [emp],
        [prev, next],
        assigned,
        NO_RULES,
      );
      expect(result.valid).toBe(true);
    });
  });
});
