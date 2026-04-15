import type { Employee } from '../aggregates/employee.aggregate';
import type { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';

export type StrategyType = 'cost' | 'fairness' | 'hybrid';

/**
 * Sentinel que indica que TODOS los empleados están bloqueados para un turno.
 * Usado por SemanticConstraintInterpreter para reglas tipo "el 16 nadie trabaja".
 */
export const SEMANTIC_BLOCKED_ALL = '*';

/**
 * SemanticConstraint — contrato entre el RAG y las estrategias de scheduling.
 *
 * El SemanticConstraintInterpreter enriquece este objeto con IDs resueltos:
 *   - employeeId: ID del empleado bloqueado, o SEMANTIC_BLOCKED_ALL para todos
 *   - shiftId:    ID del turno afectado (undefined = aplica a todos los turnos)
 *
 * weight refleja la prioridad de la regla:
 *   3 = legal (hard constraint, bloqueo absoluto)
 *   2 = semántica (hard constraint)
 *   1 = preferencia (soft constraint, penalización de score)
 */
export interface SemanticConstraint {
  rule: string;
  weight: number;
  employeeId?: string;
  shiftId?: string;
}

/**
 * SchedulingStrategy — Interface del Strategy Pattern
 *
 * Cada estrategia recibe el mismo conjunto de datos y devuelve asignaciones.
 * El SchedulingEngine no sabe qué estrategia está usando — solo llama generate().
 *
 * Añadir una nueva estrategia = implementar esta interfaz + registrarla en el factory.
 */
export interface SchedulingStrategy {
  readonly type: StrategyType;

  /**
   * Genera el conjunto de asignaciones para la semana.
   *
   * @param employees       Empleados disponibles
   * @param slots           Slots virtuales (template × fecha) a cubrir
   * @param histories       Historial de fairness
   * @param semanticRules   Constraints resueltos por StructuredRuleResolver
   * @returns               Asignaciones generadas + slots sin cubrir
   */
  generate(
    employees: Employee[],
    slots: VirtualShiftSlot[],
    histories: FairnessHistoryVO[],
    semanticRules?: SemanticConstraint[],
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>,
    multiShiftPermits?: Set<string>,
  ): StrategyResult;
}

export interface StrategyResult {
  assignments: ShiftAssignment[];
  unfilledSlots: VirtualShiftSlot[];
}
