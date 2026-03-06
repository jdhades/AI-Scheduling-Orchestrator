import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { CompanySkill } from '../aggregates/company-skill.aggregate';

export interface SkillValidationResult {
    allowed: boolean;
    reason?: string;
}

/**
 * SkillValidationPolicy — Domain Policy
 *
 * Valida si un empleado puede trabajar un turno determinado.
 *
 * Jerarquía de validaciones (en orden de prioridad):
 *   1. El empleado tiene el skill requerido por el turno
 *   2. La certificación del skill es vigente en la fecha del turno
 *   3. El empleado tiene la experiencia mínima requerida por el skill
 */
export class SkillValidationPolicy {
    /**
     * Valida que el skill pertenece a la misma empresa que el empleado.
     * Usado por Employee.assignSkill() (Escenario 1).
     */
    validateEmployee(employee: Employee, skill: CompanySkill): void {
        if (skill.companyId !== employee.companyId) {
            throw new Error('Skill does not belong to employee company');
        }
    }

    canWork(
        employee: Employee,
        shift: Shift,
        availableSkills: CompanySkill[],
        shiftDate: Date,
    ): SkillValidationResult {
        // Turno sin skill requerido — cualquier empleado puede trabajarlo
        if (!shift.requiredSkillId) {
            return { allowed: true };
        }

        // 1. ¿El empleado tiene el skill?
        const employeeSkillIds = employee.getSkills().map(s => s.id);
        if (!employeeSkillIds.includes(shift.requiredSkillId)) {
            return {
                allowed: false,
                reason: `Employee does not have required skill: ${shift.requiredSkillId}`,
            };
        }

        // Obtener el detalle del skill
        const skill = availableSkills.find(s => s.id === shift.requiredSkillId);
        if (!skill) {
            return {
                allowed: false,
                reason: `Skill definition not found: ${shift.requiredSkillId}`,
            };
        }

        // 2. ¿La certificación está vigente?
        if (!skill.isValidOn(shiftDate)) {
            return {
                allowed: false,
                reason: `Certification for skill '${skill.name}' expired on ${skill.certificationExpiration?.toISOString()}`,
            };
        }

        // 3. ¿El empleado tiene la experiencia mínima?
        if (employee.experienceMonths < skill.requiredExperienceMonths) {
            return {
                allowed: false,
                reason: `Employee has ${employee.experienceMonths} months experience, skill '${skill.name}' requires ${skill.requiredExperienceMonths}`,
            };
        }

        return { allowed: true };
    }

    /**
     * Filtra la lista de empleados candidatos para un turno.
     * Útil para las estrategias cuando pre-construyen el pool de candidatos.
     */
    filterCandidates(
        employees: Employee[],
        shift: Shift,
        availableSkills: CompanySkill[],
        shiftDate: Date,
    ): Employee[] {
        return employees.filter(
            emp => this.canWork(emp, shift, availableSkills, shiftDate).allowed,
        );
    }
}