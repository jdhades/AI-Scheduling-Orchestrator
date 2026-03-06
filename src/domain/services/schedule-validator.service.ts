import { Injectable } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';

/**
 * Resultado de la validación de una propuesta de asignación del LLM.
 */
export interface AssignmentValidationResult {
    valid: boolean;
    shiftId: string;
    employeeId: string;
    violations: string[];
}

/**
 * ScheduleValidatorService — Servicio de dominio
 *
 * Valida que una asignación propuesta por el LLM respete todas las
 * restricciones duras del sistema:
 *  1. El empleado y el turno deben existir en el set actual
 *  2. El empleado debe tener la skill requerida por el turno
 *  3. No debe haber solapamiento con asignaciones previas del mismo empleado
 *  4. Las reglas semánticas de prioridad 1 (legales) no deben infringirse
 *
 * Esta es la "red de seguridad" del Prompt Orchestrator: garantiza que
 * el horario final nunca viole restricciones duras, aunque el LLM proponga
 * algo incorrecto.
 */
@Injectable()
export class ScheduleValidatorService {

    /**
     * Valida una propuesta de asignación individual.
     *
     * @param shiftId         ID del turno propuesto
     * @param employeeId      ID del empleado propuesto
     * @param employees       Conjunto de empleados disponibles
     * @param shifts          Conjunto de turnos a cubrir
     * @param alreadyAssigned Mapa employeeId → turnos ya asignados en este schedule
     * @param semanticRules   Restricciones semánticas (del RAG)
     */
    validate(
        shiftId: string,
        employeeId: string,
        employees: Employee[],
        shifts: Shift[],
        alreadyAssigned: Map<string, Shift[]>,
        semanticRules: SemanticConstraint[],
    ): AssignmentValidationResult {
        const violations: string[] = [];

        // 1. Verificar existencia
        const employee = employees.find(e => e.id === employeeId);
        const shift = shifts.find(s => s.id === shiftId);

        if (!employee) {
            violations.push(`Employee ${employeeId} not found in current employee pool`);
            return { valid: false, shiftId, employeeId, violations };
        }

        if (!shift) {
            violations.push(`Shift ${shiftId} not found in current shift list`);
            return { valid: false, shiftId, employeeId, violations };
        }

        // 2. Verificar skill requerida
        if (shift.requiredSkillId) {
            const hasSkill = employee.getSkills().some(s => s.id === shift.requiredSkillId);
            if (!hasSkill) {
                violations.push(
                    `Employee ${employeeId} lacks required skill ${shift.requiredSkillId} for shift ${shiftId}`,
                );
            }
        }

        // 3. Verificar solapamiento con turnos ya asignados
        const existingShifts = alreadyAssigned.get(employeeId) ?? [];
        const overlapping = existingShifts.find(s => s.overlapsWith(shift));
        if (overlapping) {
            violations.push(
                `Employee ${employeeId} has overlapping shift ${overlapping.id} with proposed shift ${shiftId}`,
            );
        }

        // 4. Verificar restricciones semánticas LEGALES (prioridad 1)
        //    Estas son absolutas — el LLM nunca puede violarlas
        const legalRestrictions = semanticRules.filter(
            r => r.weight >= 1 && (r as any).priority === 1,
        );
        for (const restriction of legalRestrictions) {
            // Si la restricción aplica específicamente a este empleado o turno
            if (restriction.employeeId === employeeId || restriction.shiftId === shiftId) {
                violations.push(
                    `Legal restriction violated: "${restriction.rule}" applies to employee/shift`,
                );
            }
        }

        return {
            valid: violations.length === 0,
            shiftId,
            employeeId,
            violations,
        };
    }

    /**
     * Comprueba si un empleado está disponible para un turno adicional
     * (sin turnos solapados ya asignados).
     */
    isAvailable(
        employee: Employee,
        shift: Shift,
        alreadyAssigned: Map<string, Shift[]>,
    ): boolean {
        const busy = alreadyAssigned.get(employee.id) ?? [];
        return !busy.some(s => s.overlapsWith(shift));
    }
}
