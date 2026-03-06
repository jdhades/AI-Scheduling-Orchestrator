import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { CompanySkill } from '../aggregates/company-skill.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import { FairnessScore } from '../value-objects/fairness-score.vo';
import { FairnessCalculator } from './fairness-calculator.service';
import { FairnessThresholdGuard } from './fairness-threshold-guard.service';
import { SkillValidationPolicy } from '../policies/skill-validation.policy';

export interface ConflictResolutionResult {
    valid: boolean;
    reason?: string;
    alternativeSuggestion?: Employee;
}

/**
 * ConflictResolutionService — Domain Service
 *
 * Resuelve conflictos antes de confirmar una asignación.
 *
 * Jerarquía (en orden de precedencia):
 *   1. Legal rules    — horas máximas, descanso mínimo entre turnos
 *   2. Skill constraints — tiene skill, vigente, experiencia suficiente
 *   3. Fairness threshold — no supera la desviación máxima
 *   4. Preferences — disponibilidad declarada (pendiente implementación completa)
 */
export class ConflictResolutionService {
    private static readonly MAX_WEEKLY_HOURS = 40;
    private static readonly MIN_REST_HOURS = 11; // Directiva EU jornada laboral

    constructor(
        private readonly skillPolicy: SkillValidationPolicy,
        private readonly fairnessCalc: FairnessCalculator,
        private readonly thresholdGuard: FairnessThresholdGuard,
    ) { }

    resolve(
        employee: Employee,
        shift: Shift,
        companySkills: CompanySkill[],
        weeklyHistory: FairnessHistoryVO,
        assignedShiftsThisWeek: Shift[],
        candidates: Employee[],
    ): ConflictResolutionResult {
        // 1. Legal rules
        const legalResult = this.checkLegalRules(shift, assignedShiftsThisWeek, weeklyHistory);
        if (!legalResult.valid) return legalResult;

        // 2. Skill constraints
        const skillResult = this.skillPolicy.canWork(employee, shift, companySkills, shift.startTime);
        if (!skillResult.allowed) {
            const alt = this.findAlternative(candidates, shift, companySkills);
            return {
                valid: false,
                reason: skillResult.reason,
                alternativeSuggestion: alt,
            };
        }

        // 3. Fairness threshold
        const score = this.fairnessCalc.compute(weeklyHistory);
        if (shift.undesirableWeight.isHeavy() && !this.thresholdGuard.canReceiveHeavyShift(score.value)) {
            const alt = this.findAlternative(candidates, shift, companySkills);
            return {
                valid: false,
                reason: `Employee fairness score ${score.value} exceeds threshold ${this.thresholdGuard.threshold}`,
                alternativeSuggestion: alt,
            };
        }

        return { valid: true };
    }

    private checkLegalRules(
        shift: Shift,
        assignedThisWeek: Shift[],
        history: FairnessHistoryVO,
    ): ConflictResolutionResult {
        // Verificar horas semanales máximas
        const projectedHours = history.hoursWorked + shift.getDuration();
        if (projectedHours > ConflictResolutionService.MAX_WEEKLY_HOURS) {
            return {
                valid: false,
                reason: `Assigning this shift would exceed ${ConflictResolutionService.MAX_WEEKLY_HOURS}h weekly limit (projected: ${projectedHours.toFixed(1)}h)`,
            };
        }

        // Verificar descanso mínimo entre turnos (11h EU)
        const hasInsufficientRest = assignedThisWeek.some(existing => {
            const gapBefore = (shift.startTime.getTime() - existing.endTime.getTime()) / (1000 * 60 * 60);
            const gapAfter = (existing.startTime.getTime() - shift.endTime.getTime()) / (1000 * 60 * 60);
            return (gapBefore >= 0 && gapBefore < ConflictResolutionService.MIN_REST_HOURS)
                || (gapAfter >= 0 && gapAfter < ConflictResolutionService.MIN_REST_HOURS);
        });

        if (hasInsufficientRest) {
            return {
                valid: false,
                reason: `Insufficient rest between shifts (EU minimum: ${ConflictResolutionService.MIN_REST_HOURS}h)`,
            };
        }

        return { valid: true };
    }

    private findAlternative(
        candidates: Employee[],
        shift: Shift,
        companySkills: CompanySkill[],
    ): Employee | undefined {
        return candidates.find(c => {
            const result = this.skillPolicy.canWork(c, shift, companySkills, shift.startTime);
            return result.allowed;
        });
    }
}
