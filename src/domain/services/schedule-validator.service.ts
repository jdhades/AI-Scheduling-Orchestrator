import { Injectable, Logger } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../strategies/scheduling-strategy.interface';
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';

export interface AssignmentValidationResult {
  valid: boolean;
  slotKey: string;
  employeeId: string;
  violations: string[];
}

/**
 * Entrada mínima que el validator conserva por empleado en el buffer de
 * asignaciones ya aceptadas durante la generación. El `slotKey` es el
 * identificador virtual (`templateId|YYYY-MM-DD`), no un UUID de BD.
 */
export interface BusyAssignment {
  slotKey: string;
  startTime: Date;
  endTime: Date;
  overlapsWith(other: { startTime: Date; endTime: Date }): boolean;
}

/**
 * ScheduleValidatorService — Servicio de dominio
 *
 * Red de seguridad del Prompt Orchestrator: cualquier asignación propuesta
 * (por el LLM o por las strategies) pasa por aquí antes de aceptarse. El
 * validator opera sobre VirtualShiftSlot — no conoce el modelo legacy Shift.
 */
@Injectable()
export class ScheduleValidatorService {
  private readonly logger = new Logger(ScheduleValidatorService.name);

  validate(
    slotKey: string,
    employeeId: string,
    employees: Employee[],
    slots: VirtualShiftSlot[],
    alreadyAssigned: Map<string, BusyAssignment[]>,
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
      `validate(slot=${slotKey.slice(0, 12)} emp=${employeeId.slice(0, 8)}): ${semanticRules.length} rules (${hardCount} hard, ${resolvedCount} with resolved IDs)`,
    );

    const employee = employees.find((e) => e.id === employeeId);
    const slot = slots.find((s) => s.slotKey === slotKey);

    if (!employee) {
      violations.push(
        `Employee ${employeeId} not found in current employee pool`,
      );
      return { valid: false, slotKey, employeeId, violations };
    }

    if (!slot) {
      violations.push(`Slot ${slotKey} not found in current slot list`);
      return { valid: false, slotKey, employeeId, violations };
    }

    if (slot.requiredSkillId) {
      const hasSkill = employee
        .getSkills()
        .some((s) => s.id === slot.requiredSkillId);
      if (!hasSkill) {
        violations.push(
          `Employee ${employeeId} lacks required skill ${slot.requiredSkillId} for slot ${slotKey}`,
        );
      }
    }

    const existing = alreadyAssigned.get(employeeId) ?? [];
    const overlapping = existing.find((s) => s.overlapsWith(slot));
    if (overlapping) {
      violations.push(
        `Employee ${employeeId} has overlapping slot ${overlapping.slotKey} with proposed slot ${slotKey}`,
      );
    }

    // Un turno por empleado por día (salvo permit explícito)
    const sameDay = existing.find((s) => s.slotKey !== slotKey && s.startTime.toISOString().split('T')[0] === slot.date);
    if (sameDay) {
      const permitted = multiShiftPermits?.has(`${employeeId}|${slot.date}`);
      if (!permitted) {
        violations.push(
          `Employee ${employeeId} already has slot ${sameDay.slotKey} on ${slot.date} — only one shift per day unless explicitly permitted by a semantic rule`,
        );
      }
    }

    if (!employee.isAvailable(slot.startTime, slot.endTime)) {
      violations.push(
        `Employee ${employeeId} has no availability window covering slot ${slotKey} ` +
          `(${slot.startTime.toISOString()} – ${slot.endTime.toISOString()})`,
      );
    }

    void workingTimePolicies;

    const hardSemanticBlocks = semanticRules.filter((c) => c.weight >= 2);
    const slotFullyBlocked = hardSemanticBlocks.some(
      (c) => c.employeeId === SEMANTIC_BLOCKED_ALL && c.shiftId === slotKey,
    );
    if (slotFullyBlocked) {
      violations.push(
        `Slot ${slotKey} is blocked for all employees by hard semantic rule (e.g. holiday)`,
      );
    }

    const employeeBlocked = hardSemanticBlocks.some(
      (c) =>
        c.employeeId &&
        c.employeeId !== SEMANTIC_BLOCKED_ALL &&
        c.employeeId === employeeId &&
        (!c.shiftId || c.shiftId === slotKey),
    );
    if (employeeBlocked) {
      violations.push(
        `Employee ${employeeId} is blocked from slot ${slotKey} by hard semantic rule`,
      );
    }

    return {
      valid: violations.length === 0,
      slotKey,
      employeeId,
      violations,
    };
  }

  isAvailable(
    employee: Employee,
    slot: VirtualShiftSlot,
    alreadyAssigned: Map<string, BusyAssignment[]>,
  ): boolean {
    const busy = alreadyAssigned.get(employee.id) ?? [];
    return !busy.some((s) => s.overlapsWith(slot));
  }
}
