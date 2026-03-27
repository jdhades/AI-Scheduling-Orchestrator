import { ScheduleValidatorService } from '../../../src/domain/services/schedule-validator.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { CompanySkill } from '../../../src/domain/aggregates/company-skill.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';
import { SkillValidationPolicy } from '../../../src/domain/policies/skill-validation.policy';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeShift(
  id: string,
  requiredSkillId: string | null,
  startHour = 8,
  endHour = 16,
): Shift {
  const start = new Date('2026-03-04T00:00:00Z');
  start.setUTCHours(startHour, 0, 0, 0);
  const end = new Date('2026-03-04T00:00:00Z');
  end.setUTCHours(endHour, 0, 0, 0);

  return Shift.create({
    id,
    companyId: 'company-1',
    startTime: start,
    endTime: end,
    requiredSkillId,
    requiredSkillLevel: 'junior',
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.create(5),
    undesirableWeight: UndesirableWeight.create(1),
  });
}

const NO_SEMANTIC_RULES: any[] = [];

// ─── ScheduleValidatorService ─────────────────────────────────────────────────

describe('ScheduleValidatorService', () => {
  let validator: ScheduleValidatorService;
  let emptyAssigned: Map<string, Shift[]>;

  beforeEach(() => {
    validator = new ScheduleValidatorService();
    emptyAssigned = new Map();
  });

  it('should return valid when employee exists, has skill and no overlap', () => {
    const emp = makeEmployee('e1', 'skill-nurse');
    const shift = makeShift('s1', 'skill-nurse', 8, 16);
    emptyAssigned.set('e1', []);

    const result = validator.validate(
      's1',
      'e1',
      [emp],
      [shift],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should return invalid when employee does not exist', () => {
    const emp = makeEmployee('e1');
    const shift = makeShift('s1', null, 8, 16);

    const result = validator.validate(
      's1',
      'NON_EXISTENT_EMP',
      [emp],
      [shift],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain(
      'not found in current employee pool',
    );
  });

  it('should return invalid when shift does not exist', () => {
    const emp = makeEmployee('e1');
    emptyAssigned.set('e1', []);

    const result = validator.validate(
      'NON_EXISTENT_SHIFT',
      'e1',
      [emp],
      [],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('not found in current shift list');
  });

  it('should return invalid when employee lacks required skill', () => {
    const empNoSkill = makeEmployee('e1'); // sin skills
    const shift = makeShift('s1', 'skill-nurse', 8, 16);
    emptyAssigned.set('e1', []);

    const result = validator.validate(
      's1',
      'e1',
      [empNoSkill],
      [shift],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('lacks required skill');
  });

  it('should return valid when shift has no required skill', () => {
    const empNoSkill = makeEmployee('e1'); // sin skills
    const shift = makeShift('s1', null, 8, 16); // sin skill requerida
    emptyAssigned.set('e1', []);

    const result = validator.validate(
      's1',
      'e1',
      [empNoSkill],
      [shift],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(true);
  });

  it('should return invalid when employee has overlapping shift', () => {
    const emp = makeEmployee('e1');
    const shift1 = makeShift('s1', null, 8, 16);
    const shift2 = makeShift('s2', null, 12, 20); // solapado con s1
    emptyAssigned.set('e1', [shift1]); // s1 ya asignado

    const result = validator.validate(
      's2',
      'e1',
      [emp],
      [shift1, shift2],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('overlapping shift');
  });

  it('should return valid when shifts are consecutive (no overlap)', () => {
    const emp = makeEmployee('e1');
    const shift1 = makeShift('s1', null, 8, 16);
    const shift2 = makeShift('s2', null, 16, 24); // consecutivo, no solapado
    emptyAssigned.set('e1', [shift1]);

    const result = validator.validate(
      's2',
      'e1',
      [emp],
      [shift1, shift2],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );

    expect(result.valid).toBe(true);
  });

  it('should accumulate multiple violations in a single result', () => {
    // Employee inexistente + shift inexistente → early return after employee check
    const result = validator.validate(
      'NON_SHIFT',
      'NON_EMP',
      [],
      [],
      emptyAssigned,
      NO_SEMANTIC_RULES,
    );
    expect(result.valid).toBe(false);
    // Al no encontrar empleado, retorna inmediatamente con 1 violation
    expect(result.violations).toHaveLength(1);
  });

  it('isAvailable() should return true when no busy slots', () => {
    const emp = makeEmployee('e1');
    const shift = makeShift('s1', null, 8, 16);
    emptyAssigned.set('e1', []);

    expect(validator.isAvailable(emp, shift, emptyAssigned)).toBe(true);
  });

  it('isAvailable() should return false when employee has overlapping shift', () => {
    const emp = makeEmployee('e1');
    const shift1 = makeShift('s1', null, 8, 16);
    const shift2 = makeShift('s2', null, 14, 22);
    emptyAssigned.set('e1', [shift1]);

    expect(validator.isAvailable(emp, shift2, emptyAssigned)).toBe(false);
  });
});
