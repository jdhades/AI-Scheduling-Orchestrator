import { MembershipAssignmentService } from '../../../src/domain/services/membership-assignment.service';
import { ShiftMembership } from '../../../src/domain/aggregates/shift-membership.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { SEMANTIC_BLOCKED_ALL } from '../../../src/domain/strategies/scheduling-strategy.interface';

const TPL_ID = 'tpl-diurno';
const COMPANY = 'co-1';

function makeSlot(date: string): VirtualShiftSlot {
  return VirtualShiftSlot.create({
    templateId: TPL_ID,
    companyId: COMPANY,
    date,
    startTime: new Date(`${date}T10:00:00.000Z`),
    endTime: new Date(`${date}T16:00:00.000Z`),
    templateName: 'Diurno 10-16',
  });
}

function makeMembership(empId: string, from: string, until: string | null = null): ShiftMembership {
  return ShiftMembership.create({
    id: `mb-${empId}`,
    companyId: COMPANY,
    employeeId: empId,
    templateId: TPL_ID,
    effectiveFrom: from,
    effectiveUntil: until,
  });
}

function makeEmployee(id: string, name = `Emp ${id}`): Employee {
  return Employee.fromPersistence({
    id,
    companyId: COMPANY,
    name,
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, { junior: 6, intermediate: 24, senior: 999 }),
  });
}

describe('MembershipAssignmentService', () => {
  const svc = new MembershipAssignmentService();

  it('assigns members to a slot when their membership is active', () => {
    const slots = [makeSlot('2026-04-13')];
    const memberships = [makeMembership('e1', '2026-04-01')];
    const employees = [makeEmployee('e1')];

    const result = svc.generateBaseAssignments({ slots, memberships, employees });

    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe('e1');
    expect(result[0].templateId).toBe(TPL_ID);
    expect(result[0].date).toBe('2026-04-13');
    expect(result[0].origin).toBe('membership');
  });

  it('skips members whose membership ended before the slot date', () => {
    const slots = [makeSlot('2026-04-13')];
    const memberships = [makeMembership('e1', '2026-01-01', '2026-03-31')];
    const result = svc.generateBaseAssignments({ slots, memberships, employees: [makeEmployee('e1')] });
    expect(result).toHaveLength(0);
  });

  it('skips assignment when slot is fully blocked by hard semantic rule', () => {
    const slot = makeSlot('2026-04-16');
    const memberships = [makeMembership('e1', '2026-04-01')];
    const employees = [makeEmployee('e1')];
    const semanticRules = [
      {
        rule: 'feriado 16/4',
        weight: 2,
        employeeId: SEMANTIC_BLOCKED_ALL,
        shiftId: slot.slotKey,
      },
    ];
    const result = svc.generateBaseAssignments({ slots: [slot], memberships, employees, semanticRules });
    expect(result).toHaveLength(0);
  });

  it('skips a specific employee blocked from a slot by hard rule', () => {
    const slot = makeSlot('2026-04-13');
    const memberships = [makeMembership('e1', '2026-04-01'), makeMembership('e2', '2026-04-01')];
    const employees = [makeEmployee('e1'), makeEmployee('e2')];
    const semanticRules = [
      { rule: 'e1 libre', weight: 2, employeeId: 'e1', shiftId: slot.slotKey },
    ];
    const result = svc.generateBaseAssignments({ slots: [slot], memberships, employees, semanticRules });
    expect(result.map((a) => a.employeeId)).toEqual(['e2']);
  });

  it('enforces one-shift-per-day per employee unless permit exists', () => {
    const slot1 = VirtualShiftSlot.create({
      templateId: 't-morning',
      companyId: COMPANY,
      date: '2026-04-13',
      startTime: new Date('2026-04-13T10:00:00.000Z'),
      endTime: new Date('2026-04-13T16:00:00.000Z'),
      templateName: 'Morning',
    });
    const slot2 = VirtualShiftSlot.create({
      templateId: 't-night',
      companyId: COMPANY,
      date: '2026-04-13',
      startTime: new Date('2026-04-13T16:00:00.000Z'),
      endTime: new Date('2026-04-13T22:00:00.000Z'),
      templateName: 'Night',
    });
    const memberships = [
      ShiftMembership.create({
        id: 'mb-morning',
        companyId: COMPANY,
        employeeId: 'e1',
        templateId: 't-morning',
        effectiveFrom: '2026-04-01',
      }),
      ShiftMembership.create({
        id: 'mb-night',
        companyId: COMPANY,
        employeeId: 'e1',
        templateId: 't-night',
        effectiveFrom: '2026-04-01',
      }),
    ];
    const employees = [makeEmployee('e1')];

    const noPermits = svc.generateBaseAssignments({ slots: [slot1, slot2], memberships, employees });
    expect(noPermits).toHaveLength(1); // solo el primero (morning)

    const withPermit = svc.generateBaseAssignments({
      slots: [slot1, slot2],
      memberships,
      employees,
      multiShiftPermits: new Set(['e1|2026-04-13']),
    });
    expect(withPermit).toHaveLength(2);
  });
});
