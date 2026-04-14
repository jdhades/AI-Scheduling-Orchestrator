import { CostOptimizedStrategy } from '../../../src/domain/strategies/cost-optimized.strategy';
import { FairnessOptimizedStrategy } from '../../../src/domain/strategies/fairness-optimized.strategy';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';
import { EmployeePreference } from '../../../src/domain/value-objects/employee-preference.vo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeShift(id: string, startIso: string, endIso: string): Shift {
  return Shift.create({
    id,
    companyId: 'company-1',
    startTime: new Date(startIso),
    endTime: new Date(endIso),
    requiredSkillId: null,
    requiredSkillLevel: 'junior',
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.create(5),
    undesirableWeight: UndesirableWeight.create(1),
  });
}

// ─── CostOptimizedStrategy — Availability & Gap Filter ────────────────────────

describe('CostOptimizedStrategy — Phase 1 Filters', () => {
  const strategy = new CostOptimizedStrategy();

  it('should NOT assign a shift to an employee who is structurally unavailable', () => {
    // Tuesday only window, but shift is on Wednesday
    const tuesdayOnly = new EmployeeAvailability('a1', 2, '09:00', '17:00');
    const emp = makeEmployee('emp-unavail', { availability: [tuesdayOnly] });

    // Wednesday shift (2026-03-11 = Wednesday)
    const shift = makeShift(
      's1',
      '2026-03-11T09:00:00Z',
      '2026-03-11T17:00:00Z',
    );

    const result = strategy.generate([emp], [shift], []);
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledShifts).toHaveLength(1);
    expect(result.unfilledShifts[0].id).toBe('s1');
  });

  it('should assign a shift to an available employee', () => {
    // Wednesday window covering the shift
    const wednesdayWindow = new EmployeeAvailability('a2', 3, '09:00', '17:00');
    const emp = makeEmployee('emp-avail', { availability: [wednesdayWindow] });

    const shift = makeShift(
      's1',
      '2026-03-11T09:00:00Z',
      '2026-03-11T17:00:00Z',
    );

    const result = strategy.generate([emp], [shift], []);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].employeeId).toBe('emp-avail');
  });

  it('assigns only one shift per day by default (hard constraint)', () => {
    // Regla base nueva: un empleado solo puede tener 1 turno/día.
    // Solo una regla semántica explícita (vía multiShiftPermits) puede permitir más.
    const emp = makeEmployee('emp-1', { availability: [] });
    const shift1 = makeShift(
      's1',
      '2026-03-09T08:00:00Z',
      '2026-03-09T16:00:00Z',
    );
    const shift2 = makeShift(
      's2',
      '2026-03-09T16:00:00Z',
      '2026-03-10T00:00:00Z',
    );

    const result = strategy.generate([emp], [shift1, shift2], []);
    expect(result.assignments).toHaveLength(1);
    expect(result.unfilledShifts).toHaveLength(1);
  });

  it('allows 2 shifts same day when multiShiftPermits authorizes it', () => {
    const emp = makeEmployee('emp-1', { availability: [] });
    const shift1 = makeShift(
      's1',
      '2026-03-09T08:00:00Z',
      '2026-03-09T12:00:00Z',
    );
    const shift2 = makeShift(
      's2',
      '2026-03-09T16:00:00Z',
      '2026-03-09T20:00:00Z',
    );
    const permits = new Set(['emp-1|2026-03-09']);

    const result = strategy.generate(
      [emp],
      [shift1, shift2],
      [],
      undefined,
      undefined,
      permits,
    );
    expect(result.assignments).toHaveLength(2);
    expect(result.unfilledShifts).toHaveLength(0);
  });

  it('assigns 40+ hours (soft cap) — warning emitted by orchestrator, not strategy', () => {
    // Caps de horas/día y horas/semana son SOFT desde el refactor de jerarquía
    // (empleado → depto → tenant → fallback). Se respeta el gap mínimo entre turnos
    // y la disponibilidad, pero el exceso se reporta como warning — el manager decide.
    const emp = makeEmployee('emp-1', { availability: [] });
    const shifts = [
      makeShift('s1', '2026-03-09T08:00:00Z', '2026-03-09T16:00:00Z'), // Mon
      makeShift('s2', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z'), // Tue
      makeShift('s3', '2026-03-11T08:00:00Z', '2026-03-11T16:00:00Z'), // Wed
      makeShift('s4', '2026-03-12T08:00:00Z', '2026-03-12T16:00:00Z'), // Thu
      makeShift('s5', '2026-03-13T08:00:00Z', '2026-03-13T16:00:00Z'), // Fri
      makeShift('s6', '2026-03-14T08:00:00Z', '2026-03-14T16:00:00Z'), // Sat
    ];

    const result = strategy.generate([emp], shifts, []);
    // 6 shifts = 48h. La strategy ya no rechaza; todos se asignan.
    expect(result.assignments).toHaveLength(6);
    expect(result.unfilledShifts).toHaveLength(0);
  });
});

// ─── Preference Soft Constraint — Favors Preferred Employee ───────────────────

describe('CostOptimizedStrategy — Preference Soft Constraint', () => {
  const strategy = new CostOptimizedStrategy();

  it('prefers a MORNING employee over a neutral one for a morning shift', () => {
    const morningPref = new EmployeePreference('pref-1', 'PREFERS_MORNING', 5);
    const empPrefersMorning = makeEmployee('emp-morning', {
      experience: 12, // intermediate
      preferences: [morningPref],
    });
    const empNeutral = makeEmployee('emp-neutral', {
      experience: 12, // same seniority
      preferences: [],
    });

    // Morning shift (10:00 UTC)
    const morningShift = makeShift(
      's-morning',
      '2026-03-09T10:00:00Z',
      '2026-03-09T18:00:00Z',
    );

    const result = strategy.generate(
      [empNeutral, empPrefersMorning],
      [morningShift],
      [],
    );
    expect(result.assignments).toHaveLength(1);
    // The one who prefers mornings should be assigned (lower effective cost)
    expect(result.assignments[0].employeeId).toBe('emp-morning');
  });
});

// ─── FairnessOptimizedStrategy — Prefers Less-burdened Employee ───────────────

describe('FairnessOptimizedStrategy — Phase 1 Filters', () => {
  const strategy = new FairnessOptimizedStrategy();

  it('should not assign to an unavailable employee (fairness strategy)', () => {
    const mondayOnly = new EmployeeAvailability('a1', 1, '09:00', '17:00');
    const emp = makeEmployee('emp-1', { availability: [mondayOnly] });

    // Tuesday shift — employee is not available
    const tuesdayShift = makeShift(
      's1',
      '2026-03-10T09:00:00Z',
      '2026-03-10T17:00:00Z',
    );

    const result = strategy.generate([emp], [tuesdayShift], []);
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledShifts[0].id).toBe('s1');
  });
});
