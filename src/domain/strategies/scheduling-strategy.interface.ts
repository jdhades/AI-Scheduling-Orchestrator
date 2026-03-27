import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';

export type StrategyType = 'cost' | 'fairness' | 'hybrid';

/**
 * SemanticConstraint — contrato preparado para el Escenario 3 (RAG).
 *
 * En el Escenario 3, el SemanticRuleService llenará este array con reglas
 * extraídas del contexto semántico de la empresa (convenio colectivo, prefs, etc.)
 * Por ahora las estrategias lo reciben opccionalmente y lo ignoran.
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
   * @param employees       Empleados disponibles para la semana
   * @param shifts          Turnos a cubrir
   * @param histories       Historial de fairness de la semana actual
   * @param semanticRules   Reglas semánticas del RAG (vacío hasta Escenario 3)
   * @returns               Asignaciones generadas + turnos sin cubrir
   */
  generate(
    employees: Employee[],
    shifts: Shift[],
    histories: FairnessHistoryVO[],
    semanticRules?: SemanticConstraint[],
  ): StrategyResult;
}

export interface StrategyResult {
  assignments: ShiftAssignment[];
  unfilledShifts: Shift[];
}
