import { Injectable, Logger } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../strategies/scheduling-strategy.interface';
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';

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
  private readonly logger = new Logger(ScheduleValidatorService.name);
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
    alreadyAssigned: Map<string, { id: string; startTime: Date; endTime: Date; overlapsWith: (other: Shift) => boolean }[]>,
    semanticRules: SemanticConstraint[],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
  ): AssignmentValidationResult {
    const violations: string[] = [];

    const hardCount = semanticRules.filter((c) => c.weight >= 2).length;
    const resolvedCount = semanticRules.filter(
      (c) => c.employeeId && c.shiftId,
    ).length;
    this.logger.debug(
      `validate(shift=${shiftId.slice(0, 8)} emp=${employeeId.slice(0, 8)}): ${semanticRules.length} rules (${hardCount} hard, ${resolvedCount} with resolved IDs)`,
    );

    // 1. Verificar existencia
    const employee = employees.find((e) => e.id === employeeId);
    const shift = shifts.find((s) => s.id === shiftId);

    if (!employee) {
      violations.push(
        `Employee ${employeeId} not found in current employee pool`,
      );
      return { valid: false, shiftId, employeeId, violations };
    }

    if (!shift) {
      violations.push(`Shift ${shiftId} not found in current shift list`);
      return { valid: false, shiftId, employeeId, violations };
    }

    // 2. Verificar skill requerida
    if (shift.requiredSkillId) {
      const hasSkill = employee
        .getSkills()
        .some((s) => s.id === shift.requiredSkillId);
      if (!hasSkill) {
        violations.push(
          `Employee ${employeeId} lacks required skill ${shift.requiredSkillId} for shift ${shiftId}`,
        );
      }
    }

    // 3. Verificar solapamiento con turnos ya asignados
    const existingShifts = alreadyAssigned.get(employeeId) ?? [];
    const overlapping = existingShifts.find((s) => s.overlapsWith(shift));
    if (overlapping) {
      violations.push(
        `Employee ${employeeId} has overlapping shift ${overlapping.id} with proposed shift ${shiftId}`,
      );
    }

    // 3b. Un turno por empleado por día (salvo permit explícito)
    const shiftDay = shift.startTime.toISOString().split('T')[0];
    const otherOnSameDay = existingShifts.find(
      (s) => s.startTime.toISOString().split('T')[0] === shiftDay,
    );
    if (otherOnSameDay && otherOnSameDay.id !== shiftId) {
      const permitted = multiShiftPermits?.has(`${employeeId}|${shiftDay}`);
      if (!permitted) {
        violations.push(
          `Employee ${employeeId} already has shift ${otherOnSameDay.id} on ${shiftDay} — only one shift per day unless explicitly permitted by a semantic rule`,
        );
      }
    }

    // 4. Verificar disponibilidad estructural del empleado (Hard Constraint)
    if (!employee.isAvailable(shift.startTime, shift.endTime)) {
      violations.push(
        `Employee ${employeeId} has no availability window covering shift ${shiftId} ` +
          `(${shift.startTime.toISOString()} – ${shift.endTime.toISOString()})`,
      );
    }

    // workingTimePolicies reservado para futuras hard constraints (hoy no se aplica acá).
    void workingTimePolicies;

    // 6. Hard Semantic Constraints (weight >= 2): el LLM nunca puede violarlas.
    //    Mismo patrón que filterCandidatesForShift — solo bloquea si hay IDs resueltos
    //    (por el LLM vía blocks[] o por el SemanticConstraintInterpreter).
    const hardSemanticBlocks = semanticRules.filter((c) => c.weight >= 2);

    // 6a. Turno totalmente bloqueado (ej. feriado colectivo)
    const shiftFullyBlocked = hardSemanticBlocks.some(
      (c) =>
        c.employeeId === SEMANTIC_BLOCKED_ALL && c.shiftId === shiftId,
    );
    if (shiftFullyBlocked) {
      violations.push(
        `Shift ${shiftId} is blocked for all employees by hard semantic rule (e.g. holiday)`,
      );
    }

    // 6b. Empleado concreto bloqueado para este turno
    const employeeBlocked = hardSemanticBlocks.some(
      (c) =>
        c.employeeId &&
        c.employeeId !== SEMANTIC_BLOCKED_ALL &&
        c.employeeId === employeeId &&
        (!c.shiftId || c.shiftId === shiftId),
    );
    if (employeeBlocked) {
      violations.push(
        `Employee ${employeeId} is blocked from shift ${shiftId} by hard semantic rule`,
      );
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
    alreadyAssigned: Map<string, { id: string; startTime: Date; endTime: Date; overlapsWith: (other: Shift) => boolean }[]>,
  ): boolean {
    const busy = alreadyAssigned.get(employee.id) ?? [];
    return !busy.some((s) => s.overlapsWith(shift));
  }
}
