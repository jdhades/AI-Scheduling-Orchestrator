import type { Employee } from '../../aggregates/employee.aggregate';
import type { Shift } from '../../aggregates/shift.aggregate';
import type { SemanticConstraint } from '../scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../scheduling-strategy.interface';
import type { WorkingTimePolicyVO } from '../../value-objects/working-time-policy.vo';

/**
 * Slot ocupado de un empleado — estructura mínima para chequear solapamientos
 * y acumular horas. `Shift` lo cumple estructuralmente.
 */
export interface BusySlot {
  id: string;
  startTime: Date;
  endTime: Date;
  getDuration(): number;
  overlapsWith(other: Shift): boolean;
}

/**
 * Indexa empleados por skill para lookup O(1).
 * Compartido por las 3 estrategias para evitar duplicación.
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
 * Filtra los empleados elegibles para un turno aplicando hard constraints.
 *
 * Reglas HARD (bloquean):
 *   1. Bloqueos semánticos (weight≥2): turno completo o por empleado
 *   2. Solapamiento con turnos ya asignados (físicamente imposible)
 *   3. Disponibilidad estructural del empleado
 *   4. Un turno por empleado por día — EXCEPTO si hay un multi_shift_permit
 *      (ej. regla semántica: "Maria cubre mañana + noche el 15/04")
 *
 * Los caps de horas/día y horas/semana son informativos — no filtran.
 *
 * Compartido por hybrid, cost-optimized y fairness-optimized strategies.
 */
export function filterCandidatesForShift(params: {
  shift: Shift;
  employees: Employee[];
  skillIndex: Map<string, Employee[]>;
  busySlots: Map<string, BusySlot[]>;
  constraints?: SemanticConstraint[];
  /** Policies informativas — no filtran, se reportan como warnings. */
  workingTimePolicies?: Map<string, WorkingTimePolicyVO>;
  /** Set de `${employeeId}|${YYYY-MM-DD}` autorizados a tener 2+ turnos ese día. */
  multiShiftPermits?: Set<string>;
}): Employee[] {
  const {
    shift,
    employees,
    skillIndex,
    busySlots,
    constraints = [],
    multiShiftPermits,
  } = params;
  void params.workingTimePolicies;

  const shiftDay = shift.startTime.toISOString().split('T')[0];

  // Hard Semantic: turno completamente bloqueado (feriado, nadie trabaja)
  const shiftFullyBlocked = constraints.some(
    (c) =>
      c.weight >= 2 &&
      c.employeeId === SEMANTIC_BLOCKED_ALL &&
      c.shiftId === shift.id,
  );
  if (shiftFullyBlocked) return [];

  // IDs bloqueados específicamente para este turno (hard constraints)
  const hardBlockedIds = new Set(
    constraints
      .filter(
        (c) =>
          c.weight >= 2 &&
          c.employeeId &&
          c.employeeId !== SEMANTIC_BLOCKED_ALL &&
          (!c.shiftId || c.shiftId === shift.id),
      )
      .map((c) => c.employeeId!),
  );

  const pool = shift.requiredSkillId
    ? (skillIndex.get(shift.requiredSkillId) ?? [])
    : employees;
  const uniquePool = Array.from(new Set(pool));

  return uniquePool.filter((emp) => {
    if (hardBlockedIds.has(emp.id)) return false;

    const busy = busySlots.get(emp.id) ?? [];
    if (busy.some((s) => s.overlapsWith(shift))) return false;

    if (!emp.isAvailable(shift.startTime, shift.endTime)) return false;

    // Hard: un turno por empleado por día (a menos que haya permit explícito)
    const alreadyWorkingThisDay = busy.some(
      (s) => s.startTime.toISOString().split('T')[0] === shiftDay,
    );
    if (alreadyWorkingThisDay) {
      const permitted = multiShiftPermits?.has(`${emp.id}|${shiftDay}`);
      if (!permitted) return false;
    }

    return true;
  });
}
