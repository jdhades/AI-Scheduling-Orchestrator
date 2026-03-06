import { SkillValidationPolicy } from '../../../src/domain/policies/skill-validation.policy';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { CompanySkill } from '../../../src/domain/aggregates/company-skill.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';

/**
 * 🧪 UNIT TEST: SkillValidationPolicy
 *
 * validateEmployee() garantiza que el skill pertenezca a la empresa del empleado.
 * canWork() valida skill + certificación + experiencia para un turno específico.
 */
describe('SkillValidationPolicy', () => {

    const policy = new SkillValidationPolicy();
    const RANGES = { junior: 6, intermediate: 24, senior: 999 };

    const makeEmployee = (companyId: string): Employee =>
        Employee.create(
            'employee-1',
            companyId,
            PhoneNumber.create('+12025550100'),
            new ExperienceLevel(12, RANGES),
        );

    const makeSkill = (companyId: string): CompanySkill =>
        CompanySkill.create({
            id: 'skill-1',
            companyId,
            name: 'JavaScript',
            level: 'junior',
            requiredExperienceMonths: 0,
            certificationExpiration: null,
        });

    describe('validateEmployee()', () => {
        it('should NOT throw when employee and skill belong to the same company', () => {
            const employee = makeEmployee('company-A');
            const skill = makeSkill('company-A');

            expect(() => policy.validateEmployee(employee, skill)).not.toThrow();
        });

        it('should throw when skill belongs to a different company', () => {
            const employee = makeEmployee('company-A');
            const skill = makeSkill('company-B');

            expect(() => policy.validateEmployee(employee, skill))
                .toThrow('Skill does not belong to employee company');
        });

        it('should throw with descriptive message even with same skill-id', () => {
            const employee = makeEmployee('company-1');
            const skillOtherCompany = CompanySkill.create({
                id: 'skill-1',
                companyId: 'company-2',
                name: 'Python',
                level: 'junior',
                requiredExperienceMonths: 0,
                certificationExpiration: null,
            });

            expect(() => policy.validateEmployee(employee, skillOtherCompany))
                .toThrow('Skill does not belong to employee company');
        });

        it('should NOT throw for same company regardless of skill name', () => {
            const employee = makeEmployee('company-1');
            const skill = makeSkill('company-1');

            expect(() => policy.validateEmployee(employee, skill)).not.toThrow();
        });
    });
});
