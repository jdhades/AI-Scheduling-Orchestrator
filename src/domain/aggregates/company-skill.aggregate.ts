export type SkillLevel = 'junior' | 'intermediate' | 'senior';

export interface CreateCompanySkillProps {
    id: string;
    companyId: string;
    name: string;
    level: SkillLevel;
    requiredExperienceMonths: number;
    certificationExpiration: Date | null;
}

/**
 * CompanySkill — Domain Aggregate
 *
 * Representa una certificación/skill que una empresa define y los empleados pueden tener.
 * Puede tener una fecha de expiración (certificaciones con renovación periódica).
 */
export class CompanySkill {
    private constructor(
        public readonly id: string,
        public readonly companyId: string,
        public readonly name: string,
        public readonly level: SkillLevel,
        public readonly requiredExperienceMonths: number,
        public readonly certificationExpiration: Date | null,
    ) { }

    static create(props: CreateCompanySkillProps): CompanySkill {
        if (props.requiredExperienceMonths < 0) {
            throw new Error('requiredExperienceMonths cannot be negative');
        }
        return new CompanySkill(
            props.id,
            props.companyId,
            props.name,
            props.level,
            props.requiredExperienceMonths,
            props.certificationExpiration,
        );
    }

    static fromPersistence(props: CreateCompanySkillProps): CompanySkill {
        return new CompanySkill(
            props.id,
            props.companyId,
            props.name,
            props.level,
            props.requiredExperienceMonths,
            props.certificationExpiration,
        );
    }

    /**
     * La certificación está vigente en la fecha dada.
     */
    isValidOn(date: Date): boolean {
        if (!this.certificationExpiration) return true; // sin expiración
        return this.certificationExpiration > date;
    }

    /**
     * Dos skills son iguales si tienen el mismo id.
     */
    equals(other: CompanySkill): boolean {
        return this.id === other.id;
    }
}