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

  /**
   * Borra atómicamente N assignments por id, scoped al tenant. Single
   * SQL DELETE ... WHERE id IN (...) — Postgres garantiza all-or-nothing
   * sin necesidad de transacción explícita. Devuelve los refs de las
   * que se borraron (id + templateId + date) para que el caller pueda
   * computar side-effects (ej. isUrgent post-delete) sin re-querying.
   *
   * IDs que no existen o pertenecen a otra company simplemente no
   * aparecen en el resultado — no es error.
   */
  deleteByIdsBatch(
    ids: string[],
    companyId: string,
  ): Promise<Array<{ id: string; templateId: string; date: string }>>;

  /**
   * Borra assignments del rango.
   *
   * Sin `templateIds` → borra TODAS las del rango (re-generación full).
   * Con `templateIds` → borra solo las que pertenecen a esos templates,
   * preservando assignments de OTROS templates del mismo rango. Phase
   * 14 — usado cuando el run es scoped a un departamento, para no pisar
   * los horarios de departamentos no afectados.
   */
  deleteByDateRange(
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
    templateIds?: string[],
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

  /**
   * Resuelve un ID corto (prefijo de los primeros caracteres del UUID) al
   * UUID completo de la assignment. Usado por la UX de WhatsApp, donde el
   * empleado ve IDs abreviados. Retorna null si no hay match único.
   */
  resolveShortId(shortId: string, companyId: string): Promise<string | null>;
}
