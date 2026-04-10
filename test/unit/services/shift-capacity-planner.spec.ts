import { ShiftCapacityPlannerService } from '../../../src/domain/services/shift-capacity-planner.service';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import type { SemanticConstraint } from '../../../src/domain/strategies/scheduling-strategy.interface';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeShift(
  id: string,
  day: string,   // 'YYYY-MM-DD'
  startH: number,
  endH: number,
  requiredEmployees: number | null = null,
): Shift {
  return Shift.create({
    id,
    companyId: 'company-1',
    startTime: new Date(`${day}T${String(startH).padStart(2, '0')}:00:00Z`),
    endTime: new Date(`${day}T${String(endH).padStart(2, '0')}:00:00Z`),
    requiredSkillId: null,
    requiredSkillLevel: 'junior',
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.create(5),
    undesirableWeight: UndesirableWeight.create(1),
    requiredEmployees,
  });
}

function makeEmployee(id: string, name = 'Test Employee'): Employee {
  return Employee.fromPersistence({
    id,
    companyId: 'company-1',
    name,
    role: 'Waiter',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, { junior: 6, intermediate: 24, senior: 999 }),
  });
}

function makeRule(rule: string): SemanticConstraint {
  return { rule, weight: 3 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ShiftCapacityPlannerService', () => {
  let planner: ShiftCapacityPlannerService;

  beforeEach(() => {
    planner = new ShiftCapacityPlannerService();
  });

  it('distributes 5 employees equally across 2 dynamic shifts on the same day', () => {
    const employees = [1, 2, 3, 4, 5].map((i) => makeEmployee(`e${i}`));
    const shifts = [
      makeShift('morning', '2026-04-14', 8, 16, null),
      makeShift('afternoon', '2026-04-14', 16, 24, null),
    ];

    const result = planner.plan({ employees, shifts, semanticRules: [] });

    // ceil(5/2) = 3 for the first, 2 for the second
    expect(result.get('morning')).toBe(3);
    expect(result.get('afternoon')).toBe(2);
  });

  it('assigns exact capacity for strict shifts without modification', () => {
    const employees = [1, 2, 3].map((i) => makeEmployee(`e${i}`));
    const shifts = [
      makeShift('strict-morning', '2026-04-14', 8, 16, 2),
      makeShift('strict-afternoon', '2026-04-14', 16, 24, 1),
    ];

    const result = planner.plan({ employees, shifts, semanticRules: [] });

    expect(result.get('strict-morning')).toBe(2);
    expect(result.get('strict-afternoon')).toBe(1);
  });

  it('resolves 0 capacity for dynamic shifts on a holiday (all employees excluded)', () => {
    const employees = [1, 2, 3].map((i) => makeEmployee(`e${i}`));
    const shifts = [
      makeShift('morning', '2026-04-16', 8, 16, null),
      makeShift('afternoon', '2026-04-16', 16, 24, null),
    ];
    const rules = [
      makeRule('El miércoles 2026-04-16 es feriado nacional. Todos descansan.'),
    ];

    const result = planner.plan({ employees, shifts, semanticRules: rules });

    expect(result.get('morning')).toBe(0);
    expect(result.get('afternoon')).toBe(0);
  });

  it('reduces pool when a named employee is excluded on a specific day', () => {
    const employees = [
      makeEmployee('e1', 'María García'),
      makeEmployee('e2', 'Juan Pérez'),
      makeEmployee('e3', 'Carlos López'),
    ];
    // 2026-04-14 is Tuesday / martes
    const shifts = [makeShift('morning', '2026-04-14', 8, 16, null)];
    // Use the ISO date in the rule to ensure reliable matching regardless of locale/TZ
    const rules = [makeRule('El 2026-04-14 María no puede trabajar por permiso médico.')];

    const result = planner.plan({ employees, shifts, semanticRules: rules });

    // 3 employees - 1 excluded = 2 available for the single dynamic shift
    expect(result.get('morning')).toBe(2);
  });

  it('handles independent days independently (no cross-day contamination)', () => {
    const employees = [1, 2, 3, 4].map((i) => makeEmployee(`e${i}`));
    const shifts = [
      makeShift('mon-am', '2026-04-14', 8, 16, null),  // lunes
      makeShift('mon-pm', '2026-04-14', 16, 24, null), // lunes
      makeShift('tue-am', '2026-04-15', 8, 16, null),  // martes — solo 1 turno
    ];

    const result = planner.plan({ employees, shifts, semanticRules: [] });

    // Monday: ceil(4/2) = 2 each
    expect(result.get('mon-am')).toBe(2);
    expect(result.get('mon-pm')).toBe(2);
    // Tuesday: single dynamic shift gets all 4
    expect(result.get('tue-am')).toBe(4);
  });

  it('returns capacity 1 for a single dynamic shift with 1 employee', () => {
    const employees = [makeEmployee('e1')];
    const shifts = [makeShift('only', '2026-04-14', 8, 16, null)];

    const result = planner.plan({ employees, shifts, semanticRules: [] });

    expect(result.get('only')).toBe(1);
  });

  it('does not exceed pool size: more shifts than employees', () => {
    const employees = [makeEmployee('e1'), makeEmployee('e2')];
    const shifts = [
      makeShift('s1', '2026-04-14', 6, 14, null),
      makeShift('s2', '2026-04-14', 10, 18, null),
      makeShift('s3', '2026-04-14', 14, 22, null),
    ];

    const result = planner.plan({ employees, shifts, semanticRules: [] });

    const total = (result.get('s1') ?? 0) + (result.get('s2') ?? 0) + (result.get('s3') ?? 0);
    expect(total).toBe(2); // can't exceed available employees
  });

  it('strict shifts consume the pool before distributing to dynamic shifts', () => {
    const employees = [1, 2, 3, 4, 5].map((i) => makeEmployee(`e${i}`));
    const shifts = [
      makeShift('strict', '2026-04-14', 8, 14, 3),  // consumes 3
      makeShift('dynamic', '2026-04-14', 14, 22, null), // gets remaining 2
    ];

    const result = planner.plan({ employees, shifts, semanticRules: [] });

    expect(result.get('strict')).toBe(3);
    expect(result.get('dynamic')).toBe(2); // 5 - 3 = 2
  });

  it('returns an empty map when no shifts are provided', () => {
    const employees = [makeEmployee('e1')];
    const result = planner.plan({ employees, shifts: [], semanticRules: [] });
    expect(result.size).toBe(0);
  });
});
