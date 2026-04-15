import { CostOptimizedStrategy } from '../../../src/domain/strategies/cost-optimized.strategy';
import { FairnessOptimizedStrategy } from '../../../src/domain/strategies/fairness-optimized.strategy';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';
import { EmployeePreference } from '../../../src/domain/value-objects/employee-preference.vo';

const RANGES = { junior: 6, intermediate: 24, senior: 999 };

function makeEmployee(
  id: string,
  opts?: {
    experience?: number;
    availability?: EmployeeAvailability[];
    preferences?: EmployeePreference[];
  },
): Employee {
  return Employee.fromPersistence({
    id,
    companyId: 'company-1',
    name: `Employee ${id}`,
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(opts?.experience ?? 12, RANGES),
    availability: opts?.availability,
    preferences: opts?.preferences,
  });
}

function makeSlot(
  templateId: string,
  startIso: string,
  endIso: string,
  requiredEmployees: number | null = 1,
): VirtualShiftSlot {
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
    requiredEmployees,
    demandScore: 5,
    undesirableWeight: 0.2,
  });
}

describe('CostOptimizedStrategy — Phase 1 Filters', () => {
  const strategy = new CostOptimizedStrategy();

  it('does not assign a slot to a structurally unavailable employee', () => {
    const tuesdayOnly = new EmployeeAvailability('a1', 2, '09:00', '17:00');
    const emp = makeEmployee('emp-unavail', { availability: [tuesdayOnly] });
    const slot = makeSlot('s1', '2026-03-11T09:00:00Z', '2026-03-11T17:00:00Z'); // Wednesday

    const result = strategy.generate([emp], [slot], []);
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledSlots).toHaveLength(1);
    expect(result.unfilledSlots[0].slotKey).toBe(slot.slotKey);
  });

  it('assigns a slot to an available employee', () => {
    const wednesdayWindow = new EmployeeAvailability('a2', 3, '09:00', '17:00');
    const emp = makeEmployee('emp-avail', { availability: [wednesdayWindow] });
    const slot = makeSlot('s1', '2026-03-11T09:00:00Z', '2026-03-11T17:00:00Z');

    const result = strategy.generate([emp], [slot], []);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].employeeId).toBe('emp-avail');
  });

  it('assigns only one slot per day by default (hard constraint)', () => {
    const emp = makeEmployee('emp-1', { availability: [] });
    const slot1 = makeSlot('s1', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z');
    const slot2 = makeSlot('s2', '2026-03-09T16:00:00Z', '2026-03-10T00:00:00Z');

    const result = strategy.generate([emp], [slot1, slot2], []);
    expect(result.assignments).toHaveLength(1);
    expect(result.unfilledSlots).toHaveLength(1);
  });

  it('allows 2 slots same day when multiShiftPermits authorizes it', () => {
    const emp = makeEmployee('emp-1', { availability: [] });
    const slot1 = makeSlot('s1', '2026-03-09T08:00:00Z', '2026-03-09T12:00:00Z');
    const slot2 = makeSlot('s2', '2026-03-09T16:00:00Z', '2026-03-09T20:00:00Z');
    const permits = new Set(['emp-1|2026-03-09']);

    const result = strategy.generate(
      [emp],
      [slot1, slot2],
      [],
      undefined,
      undefined,
      permits,
    );
    expect(result.assignments).toHaveLength(2);
    expect(result.unfilledSlots).toHaveLength(0);
  });

  it('assigns 40+ hours (soft cap) — warning emitted by orchestrator, not strategy', () => {
    const emp = makeEmployee('emp-1', { availability: [] });
    const slots = [
      makeSlot('s1', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z'),
      makeSlot('s2', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z'),
      makeSlot('s3', '2026-03-11T08:00:00Z', '2026-03-11T16:00:00Z'),
      makeSlot('s4', '2026-03-12T08:00:00Z', '2026-03-12T16:00:00Z'),
      makeSlot('s5', '2026-03-13T08:00:00Z', '2026-03-13T16:00:00Z'),
      makeSlot('s6', '2026-03-14T08:00:00Z', '2026-03-14T16:00:00Z'),
    ];

    const result = strategy.generate([emp], slots, []);
    expect(result.assignments).toHaveLength(6);
    expect(result.unfilledSlots).toHaveLength(0);
  });
});

describe('CostOptimizedStrategy — Preference Soft Constraint', () => {
  const strategy = new CostOptimizedStrategy();

  it('prefers a MORNING employee over a neutral one for a morning slot', () => {
    const morningPref = new EmployeePreference('pref-1', 'PREFERS_MORNING', 5);
    const empPrefersMorning = makeEmployee('emp-morning', {
      experience: 12,
      preferences: [morningPref],
    });
    const empNeutral = makeEmployee('emp-neutral', {
      experience: 12,
      preferences: [],
    });
    const morningSlot = makeSlot(
      's-morning',
      '2026-03-09T10:00:00Z',
      '2026-03-09T18:00:00Z',
    );

    const result = strategy.generate(
      [empNeutral, empPrefersMorning],
      [morningSlot],
      [],
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].employeeId).toBe('emp-morning');
  });
});

describe('FairnessOptimizedStrategy — Phase 1 Filters', () => {
  const strategy = new FairnessOptimizedStrategy();

  it('does not assign to an unavailable employee (fairness strategy)', () => {
    const mondayOnly = new EmployeeAvailability('a1', 1, '09:00', '17:00');
    const emp = makeEmployee('emp-1', { availability: [mondayOnly] });
    const slot = makeSlot('s1', '2026-03-10T09:00:00Z', '2026-03-10T17:00:00Z'); // Tuesday

    const result = strategy.generate([emp], [slot], []);
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledSlots[0].slotKey).toBe(slot.slotKey);
  });
});

// ─── Round-robin sobre slots elásticos (requiredEmployees === null) ─────────

describe('HybridStrategy — Round-robin on elastic slots', () => {
  const { HybridStrategy } = require('../../../src/domain/strategies/hybrid.strategy');
  const strategy = new HybridStrategy();

  it('with 5 employees, Diurno(target=2) + Nocturno(elastic): 2 go to Diurno, 3 to Nocturno', () => {
    const employees = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) =>
      makeEmployee(id, { availability: [] }),
    );
    const diurno = makeSlot('diurno', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z', 2);
    const nocturno = makeSlot('nocturno', '2026-03-09T20:00:00Z', '2026-03-10T04:00:00Z', null);

    const result = strategy.generate(employees, [diurno, nocturno], []);
    const byTemplate = new Map<string, number>();
    for (const a of result.assignments) {
      byTemplate.set(a.templateId, (byTemplate.get(a.templateId) ?? 0) + 1);
    }
    expect(byTemplate.get('diurno')).toBe(2);
    expect(byTemplate.get('nocturno')).toBe(3);
    expect(result.assignments).toHaveLength(5);
  });

  it('elastic-only templates: all employees distribute across them, 1 per employee per day', () => {
    const employees = ['e1', 'e2', 'e3', 'e4'].map((id) =>
      makeEmployee(id, { availability: [] }),
    );
    const tarde = makeSlot('tarde', '2026-03-09T14:00:00Z', '2026-03-09T22:00:00Z', null);
    const noche = makeSlot('noche', '2026-03-09T22:00:00Z', '2026-03-10T06:00:00Z', null);

    const result = strategy.generate(employees, [tarde, noche], []);
    expect(result.assignments).toHaveLength(4);
    const byTemplate = new Map<string, number>();
    for (const a of result.assignments) {
      byTemplate.set(a.templateId, (byTemplate.get(a.templateId) ?? 0) + 1);
    }
    // Round-robin splits 4 employees as evenly as possible over 2 slots → 2+2
    expect(byTemplate.get('tarde')).toBe(2);
    expect(byTemplate.get('noche')).toBe(2);
  });

  it('skips slots with requiredEmployees=0 (holiday-style)', () => {
    const employees = [makeEmployee('e1', { availability: [] })];
    const holiday = makeSlot('festivo', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z', 0);
    const normal = makeSlot('normal', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', 1);

    const result = strategy.generate(employees, [holiday, normal], []);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].templateId).toBe('normal');
  });
});
