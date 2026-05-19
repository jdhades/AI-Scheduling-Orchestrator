/**
 * Tipos compartidos de scheduling que sobreviven al retiro de las 3
 * strategies (hybrid/cost/fairness). Se usan en:
 *  - `ShiftAssignment.assignedByStrategy`     (persistencia auditable).
 *  - `SemanticConstraintInterpreter`          (interpretación de reglas).
 *  - `WeekScheduleBuilder`                    (filtro de reglas hard).
 *
 * El nombre `SchedulingStrategy` como contrato de algoritmo ya no existe:
 * el motor único es el builder employee-first.
 */

export type StrategyType = 'cost' | 'fairness' | 'hybrid';

/**
 * Sentinel que indica que TODOS los empleados están bloqueados para un turno.
 * Usado por StructuredRuleResolver / SemanticConstraintInterpreter para
 * reglas tipo "el 16 nadie trabaja".
 */
export const SEMANTIC_BLOCKED_ALL = '*';

/**
 * SemanticConstraint — contrato entre el RAG/resolver y el motor.
 *
 * weight:
 *   3 = legal (hard, bloqueo absoluto)
 *   2 = semántica (hard)
 *   1 = preferencia (soft — el motor la mira pero no obliga)
 */
export interface SemanticConstraint {
  rule: string;
  weight: number;
  employeeId?: string;
  shiftId?: string;
}
