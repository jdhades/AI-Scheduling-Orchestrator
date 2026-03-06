import { AggregateRoot } from '@nestjs/cqrs';
import { PhoneNumber } from '../value-objects/phone-number.vo';
import { ExperienceLevel } from '../value-objects/experience-level.vo';
import { CompanySkill } from '../aggregates/company-skill.aggregate';
import { SkillValidationPolicy } from '../policies/skill-validation.policy';
import { EmployeeRegisteredEvent } from '../events/employee-registered.event';

export class Employee extends AggregateRoot {
    private skills: CompanySkill[] = [];

    private constructor(
        public readonly id: string,
        public readonly companyId: string,
        private phoneNumber: PhoneNumber,
        private experience: ExperienceLevel
    ) { super(); }

    static create(id: string, companyId: string, phone: PhoneNumber, experience: ExperienceLevel): Employee {
        const employee = new Employee(id, companyId, phone, experience);
        // 🔔 Domain Event: raised by the aggregate itself (DDD best practice)
        employee.apply(new EmployeeRegisteredEvent(id, companyId, phone.value));
        return employee;
    }

    /**
     * Reconstituye el aggregate desde persistencia SIN disparar eventos.
     * Usado exclusivamente por los repositorios al leer de la DB.
     */
    static fromPersistence(data: {
        id: string;
        companyId: string;
        phoneNumber: PhoneNumber;
        experience: ExperienceLevel;
    }): Employee {
        return new Employee(data.id, data.companyId, data.phoneNumber, data.experience);
    }

    assignSkill(skill: CompanySkill, policy: SkillValidationPolicy) {
        policy.validateEmployee(this, skill);
        if (!this.skills.find(s => s.equals(skill))) this.skills.push(skill);
    }

    removeSkill(skillId: string) {
        this.skills = this.skills.filter(s => s.id !== skillId);
    }

    getSkills(): CompanySkill[] {
        return [...this.skills];
    }

    get phone(): string {
        return this.phoneNumber.value;
    }

    get experienceMonths(): number {
        return this.experience.months;
    }
}