import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { ShiftMembership } from '../aggregates/shift-membership.aggregate';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../strategies/scheduling-strategy.interface';

/**
 * MembershipAssignmentService — Domain Service
 *
 * Toma la lista de VirtualShiftSlot generados para la semana y las
 * membresías activas de los empleados, y produce un set base de
 * ShiftAssignment antes del LLM/algoritmo.
 *
 * Reglas aplicadas en este servicio (todas HARD):
 *  1. Empleado con membresía activa en el slot → asignación proposed.
 *  2. Semantic hard block (weight>=2) con shiftId == slotKey y employeeId
 *     concreto → descarta esa asignación del empleado.
 *  3. Semantic hard block con employeeId == SEMANTIC_BLOCKED_ALL y
 *     shiftId == slotKey → descarta TODAS las asignaciones de ese slot.
 *  4. Regla "un empleado, un turno por día": si el empleado ya tiene un
 *     slot membership-asignado ese día, el duplicado se descarta
 *     (a menos que exista un multiShiftPermit explícito).
 *
 * NO se aplica: priorización por capacity (si hay N miembros y slot pide M,
 * se asignan los N y deja que el orchestrator/LLM decida). Esa lógica queda
 * en el orchestrator.
 */
@Injectable()
export class MembershipAssignmentService {
  private readonly logger = new Logger(MembershipAssignmentService.name);

  generateBaseAssignments(params: {
    slots: VirtualShiftSlot[];
    memberships: ShiftMembership[];
    employees: Employee[];
    semanticRules?: SemanticConstraint[];
    multiShiftPermits?: Set<string>;
  }): ShiftAssignment[] {
    const {
      slots,
      memberships,
      employees,
      semanticRules = [],
      multiShiftPermits,
    } = params;

    const employeeById = new Map(employees.map((e) => [e.id, e]));
    const results: ShiftAssignment[] = [];

    // key `${employeeId}|${date}` → true si ya se asignó a ese empleado ese día
    const employeeDayUsed = new Set<string>();

    for (const slot of slots) {
      // 3. Slot bloqueado para TODOS por regla semántica
      const slotFullyBlocked = semanticRules.some(
        (c) =>
          c.weight >= 2 &&
          c.employeeId === SEMANTIC_BLOCKED_ALL &&
          c.shiftId === slot.slotKey,
      );
      if (slotFullyBlocked) continue;

      // 1. Miembros activos para este template en la fecha del slot
      const activeMembers = memberships.filter(
        (m) => m.templateId === slot.templateId && m.isActiveOn(slot.date),
      );

      for (const m of activeMembers) {
        const emp = employeeById.get(m.employeeId);
        if (!emp) continue;

        // 2. Empleado bloqueado puntualmente
        const employeeBlocked = semanticRules.some(
          (c) =>
            c.weight >= 2 &&
            c.employeeId === emp.id &&
            (!c.shiftId || c.shiftId === slot.slotKey),
        );
        if (employeeBlocked) continue;

        // 4. Un turno/día (salvo permit)
        const dayKey = `${emp.id}|${slot.date}`;
        if (employeeDayUsed.has(dayKey)) {
          const permitted = multiShiftPermits?.has(dayKey);
          if (!permitted) continue;
        }
        employeeDayUsed.add(dayKey);

        results.push(
          ShiftAssignment.create({
            id: randomUUID(),
            templateId: slot.templateId,
            date: slot.date,
            employeeId: emp.id,
            companyId: slot.companyId,
            origin: 'membership',
            strategyType: 'hybrid',
            fairnessSnapshot: {},
          }),
        );
      }
    }

    this.logger.log(
      `MembershipAssignmentService: ${results.length} base assignments from ${slots.length} slots + ${memberships.length} memberships`,
    );
    return results;
  }
}
