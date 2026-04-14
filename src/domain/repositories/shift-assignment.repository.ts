import type { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';

export const SHIFT_ASSIGNMENT_REPOSITORY = Symbol('SHIFT_ASSIGNMENT_REPOSITORY');

/**
 * IShiftAssignmentRepository — Port (Domain Layer)
 *
 * Contrato dedicado a persistir y leer ShiftAssignment, sin mezclar con la
 * vieja noción de Shift (instancia). El modelo nuevo guarda assignments
 * directamente referenciando (template_id, date) sin necesidad de un row
 * en `shifts` (esa tabla fue eliminada).
 *
 * El viejo `IShiftRepository` queda para ser eliminado/reescrito en pasos
 * posteriores del rework. Los flujos nuevos del orchestrator y handlers
 * usan ESTE repo.
 */
export interface IShiftAssignmentRepository {
  /** Upsert por id. */
  save(assignment: ShiftAssignment): Promise<void>;

  /** Borra una assignment puntual. */
  deleteById(id: string, companyId: string): Promise<void>;

  /** Borra todas las assignments del rango (típicamente toda la semana). */
  deleteByDateRange(
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
  ): Promise<number>;

  /** Encuentra una assignment por su id propio (PK). */
  findById(id: string, companyId: string): Promise<ShiftAssignment | null>;

  /** Todas las assignments del empleado en un rango de fechas. */
  findByEmployeeAndDateRange(
    employeeId: string,
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
  ): Promise<ShiftAssignment[]>;

  /** Todas las assignments de la empresa en un rango (semana, etc.). */
  findByCompanyAndDateRange(
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
  ): Promise<ShiftAssignment[]>;

  /** Todas las assignments de un slot virtual concreto (template + date). */
  findBySlot(
    templateId: string,
    dateISO: string,
    companyId: string,
  ): Promise<ShiftAssignment[]>;
}
