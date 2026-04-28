import { Company } from '../../../src/domain/aggregates/company.aggregate';
import { CompanySkill } from '../../../src/domain/aggregates/company-skill.aggregate';
import { FairnessPolicy } from '../../../src/domain/policies/fairness.policy';

/**
 * 🧪 UNIT TEST: Company Aggregate
 *
 * Company gestiona sus skills y políticas de fairness.
 * Los tests verifican que la colección es manejada correctamente
 * y que se retornan copias (inmutabilidad).
 */
describe('Company Aggregate', () => {
  const makeCompany = () => new Company('company-1', 'Acme Corp');

  const makeSkill = (id: string) =>
    CompanySkill.create({
      id,
      companyId: 'company-1',
      name: `Skill ${id}`,
      level: 'junior',
      requiredExperienceMonths: 0,
      certificationExpiration: null,
    });

  const makePolicy = (maxHours = 40) => new FairnessPolicy(maxHours);

  // ─── Constructor ──────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('should create a Company with correct id and name', () => {
      const company = makeCompany();
      expect(company.id).toBe('company-1');
      expect(company.name).toBe('Acme Corp');
    });

    it('should start with empty skills and policies', () => {
      const company = makeCompany();
      expect(company.getSkills()).toHaveLength(0);
      expect(company.getPolicies()).toHaveLength(0);
    });
  });

  // ─── addSkill() / getSkills() ─────────────────────────────────────────────
  describe('addSkill()', () => {
    it('should add a skill to the company', () => {
      const company = makeCompany();
      const skill = makeSkill('skill-1');

      company.addSkill(skill);

      expect(company.getSkills()).toHaveLength(1);
      expect(company.getSkills()[0].id).toBe('skill-1');
    });

    it('should allow adding multiple skills', () => {
      const company = makeCompany();
      company.addSkill(makeSkill('skill-1'));
      company.addSkill(makeSkill('skill-2'));
      company.addSkill(makeSkill('skill-3'));

      expect(company.getSkills()).toHaveLength(3);
    });
  });

  // ─── addPolicy() / getPolicies() ──────────────────────────────────────────
  describe('addPolicy()', () => {
    it('should add a FairnessPolicy to the company', () => {
      const company = makeCompany();
      const policy = makePolicy(40);

      company.addPolicy(policy);

      expect(company.getPolicies()).toHaveLength(1);
    });

    it('should allow adding multiple policies', () => {
      const company = makeCompany();
      company.addPolicy(makePolicy(40));
      company.addPolicy(makePolicy(48));

      expect(company.getPolicies()).toHaveLength(2);
    });
  });

  // ─── Inmutabilidad ────────────────────────────────────────────────────────
  describe('getSkills() / getPolicies() - immutability', () => {
    it('mutating the skills array returned by getSkills() should NOT affect the aggregate', () => {
      const company = makeCompany();
      company.addSkill(makeSkill('skill-1'));

      const skills = company.getSkills();
      skills.push(makeSkill('injected'));

      expect(company.getSkills()).toHaveLength(1);
    });

    it('mutating the policies array returned by getPolicies() should NOT affect the aggregate', () => {
      const company = makeCompany();
      company.addPolicy(makePolicy(40));

      const policies = company.getPolicies();
      policies.push(makePolicy(20));

      expect(company.getPolicies()).toHaveLength(1);
    });
  });
});
