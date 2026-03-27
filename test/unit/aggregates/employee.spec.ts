import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { CompanySkill } from '../../../src/domain/aggregates/company-skill.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { SkillValidationPolicy } from '../../../src/domain/policies/skill-validation.policy';

/**
 * 🧪 UNIT TEST: Employee Aggregate
 *
 * Employee es el aggregate raíz principal. Testea:
 * - Creación correcta del aggregate
 * - Asignación de skills con política de validación
 * - Inmutabilidad de la colección retornada
 *
 * 💡 Pro tip: Mockeamos la SkillValidationPolicy en el test de Employee
 * para aislar la responsabilidad. La policy tiene sus propios tests.
 */
describe('Employee Aggregate', () => {
  // ─── Factories de objetos comunes ─────────────────────────────────────────
  const COMPANY_ID = 'company-abc';
  const RANGES = { junior: 6, intermediate: 24, senior: 999 };

  const makeEmployee = (companyId = COMPANY_ID): Employee =>
    Employee.create(
      'employee-1',
      companyId,
      'John Doe',
      'Waiter',
      PhoneNumber.create('+12025550100'),
      new ExperienceLevel(12, RANGES),
    );

  const makeSkill = (id: string, companyId = COMPANY_ID): CompanySkill =>
    CompanySkill.create({
      id,
      companyId,
      name: `Skill ${id}`,
      level: 'junior',
      requiredExperienceMonths: 0,
      certificationExpiration: null,
    });

  // Policy real — no mock, porque queremos que el Employee test también cubra
  // la integración con la policy a nivel de dominio
  const policy = new SkillValidationPolicy();

  // ─── create() ─────────────────────────────────────────────────────────────
  describe('create()', () => {
    it('should create an Employee with correct id and companyId', () => {
      const employee = makeEmployee();
      expect(employee.id).toBe('employee-1');
      expect(employee.companyId).toBe(COMPANY_ID);
    });

    it('should start with an empty skills list', () => {
      const employee = makeEmployee();
      expect(employee.getSkills()).toHaveLength(0);
    });
  });

  // ─── assignSkill() ────────────────────────────────────────────────────────
  describe('assignSkill()', () => {
    it('should assign a skill that belongs to the same company', () => {
      const employee = makeEmployee();
      const skill = makeSkill('skill-1');

      employee.assignSkill(skill, policy);

      expect(employee.getSkills()).toHaveLength(1);
      expect(employee.getSkills()[0].id).toBe('skill-1');
    });

    it('should NOT duplicate a skill already assigned', () => {
      const employee = makeEmployee();
      const skill = makeSkill('skill-1');

      employee.assignSkill(skill, policy);
      employee.assignSkill(skill, policy); // segunda vez

      expect(employee.getSkills()).toHaveLength(1);
    });

    it('should allow assigning multiple different skills', () => {
      const employee = makeEmployee();
      const skill1 = makeSkill('skill-1');
      const skill2 = makeSkill('skill-2');

      employee.assignSkill(skill1, policy);
      employee.assignSkill(skill2, policy);

      expect(employee.getSkills()).toHaveLength(2);
    });

    it('should throw when assigning a skill from a different company', () => {
      const employee = makeEmployee('company-A');
      const foreignSkill = makeSkill('skill-foreign', 'company-B');

      expect(() => employee.assignSkill(foreignSkill, policy)).toThrow(
        'Skill does not belong to employee company',
      );
    });
  });

  // ─── removeSkill() ────────────────────────────────────────────────────────
  describe('removeSkill()', () => {
    it('should remove a skill by id', () => {
      const employee = makeEmployee();
      const skill1 = makeSkill('skill-1');
      const skill2 = makeSkill('skill-2');

      employee.assignSkill(skill1, policy);
      employee.assignSkill(skill2, policy);
      employee.removeSkill('skill-1');

      const skills = employee.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('skill-2');
    });

    it('should do nothing when removing a skill that does not exist', () => {
      const employee = makeEmployee();
      const skill = makeSkill('skill-1');
      employee.assignSkill(skill, policy);

      employee.removeSkill('non-existent-skill');

      expect(employee.getSkills()).toHaveLength(1);
    });

    it('should result in empty list after removing the only skill', () => {
      const employee = makeEmployee();
      const skill = makeSkill('skill-1');

      employee.assignSkill(skill, policy);
      employee.removeSkill('skill-1');

      expect(employee.getSkills()).toHaveLength(0);
    });
  });

  // ─── getSkills() - Inmutabilidad ──────────────────────────────────────────
  describe('getSkills() - immutability', () => {
    it('should return a copy — mutating the result does NOT affect the aggregate', () => {
      const employee = makeEmployee();
      const skill = makeSkill('skill-1');
      employee.assignSkill(skill, policy);

      // Obtenemos el array e intentamos mutarlo
      const skills = employee.getSkills();
      skills.push(makeSkill('injected-skill'));

      // El aggregate no debe haber cambiado
      expect(employee.getSkills()).toHaveLength(1);
    });
  });
});
