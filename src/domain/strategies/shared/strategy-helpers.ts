import type { Employee } from '../../aggregates/employee.aggregate';
import type { SemanticConstraint } from '../scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../scheduling-strategy.interface';
import type { VirtualShiftSlot } from '../../value-objects/virtual-shift-slot.vo';
import type { WorkingTimePolicyVO } from '../../value-objects/working-time-policy.vo';

/**
 * Slot ocupado de un empleado — estructura mínima para chequear solapamientos
 * y acumular horas. `VirtualShiftSlot` lo cumple estructuralmente.
 */
export interface BusySlot {
  slotKey: string;
  startTime: Date;
  endTime: Date;
  getDuration(): number;
  overlapsWith(other: { startTime: Date; endTime: Date }): boolean;
}

/**
 * Indexa empleados por skill para lookup O(1).
 */
export function buildSkillIndex(employees: Employee[]): Map<string, Employee[]> {
  const index = new Map<string, Employee[]>();
  for (const emp of employees) {
    for (const skill of emp.getSkills()) {
      if (!index.has(skill.id)) index.set(skill.id, []);
      index.get(skill.id)!.push(emp);
    }
  }
  return index;
}

/**
 * Filtra los empleados elegibles para un slot aplicando hard constraints.
 *
 * Reglas HARD (bloquean):
 *   1. Bloqueos semánticos (weight≥2): slot completo o por empleado
 *   2. Solapamiento con slots ya asignados al empleado
 *   3. Disponibilidad estructural del empleado
 *   4. Un slot por empleado por día — EXCEPTO si hay multiShiftPermit
 *
 * Los caps de horas/día y horas/semana son informativos — no filtran.
 * Compartido por hybrid, cost-optimized y fairness-optimized strategies.
 */
export function filterCandidatesForSlot(params: {
  slot: VirtualShiftSlot;
  employees: Employee[];
  skillIndex: Map<string, Employee[]>;
  busySlots: Map<string, BusySlot[]>;
  constraints?: SemanticConstraint[];
  workingTimePolicies?: Map<string, WorkingTimePolicyVO>;
  multiShiftPermits?: Set<string>;
}): Employee[] {
  const {
    slot,
    employees,
    skillIndex,
    busySlots,
    constraints = [],
    multiShiftPermits,
  } = params;
  void params.workingTimePolicies;

  // Slot completamente bloqueado (feriado, nadie trabaja)
  const slotFullyBlocked = constraints.some(
    (c) =>
      c.weight >= 2 &&
      c.employeeId === SEMANTIC_BLOCKED_ALL &&
      c.shiftId === slot.slotKey,
  );
  if (slotFullyBlocked) return [];

  // IDs bloqueados específicamente para este slot
  const hardBlockedIds = new Set(
    constraints
      .filter(
        (c) =>
          c.weight >= 2 &&
          c.employeeId &&
          c.employeeId !== SEMANTIC_BLOCKED_ALL &&
          (!c.shiftId || c.shiftId === slot.slotKey),
      )
      .map((c) => c.employeeId!),
  );

  const pool = slot.requiredSkillId
    ? (skillIndex.get(slot.requiredSkillId) ?? [])
    : employees;
  const uniquePool = Array.from(new Set(pool));

  return uniquePool.filter((emp) => {
    if (hardBlockedIds.has(emp.id)) return false;

    const busy = busySlots.get(emp.id) ?? [];
    if (busy.some((s) => s.overlapsWith(slot))) return false;

    if (!emp.isAvailable(slot.startTime, slot.endTime)) return false;

    // Un slot por empleado por día (salvo permit explícito)
    const alreadyWorkingThisDay = busy.some(
      (s) => s.startTime.toISOString().split('T')[0] === slot.date,
    );
    if (alreadyWorkingThisDay) {
      const permitted = multiShiftPermits?.has(`${emp.id}|${slot.date}`);
      if (!permitted) return false;
    }

    return true;
  });
}
