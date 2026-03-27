import type { Shift } from '../aggregates/shift.aggregate';
import type { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';

/**
 * IShiftRepository — Port (Domain Layer)
 *
 * Contrato que la infraestructura debe implementar para persistir
 * y recuperar turnos y asignaciones.
 */
export interface IShiftRepository {
  /**
   * Persiste un turno nuevo o actualiza uno existente.
   */
  save(shift: Shift): Promise<void>;

  /**
   * Devuelve todos los turnos de una empresa para una semana dada.
   * weekStart debe ser el lunes de la semana (00:00:00).
   */
  findByCompanyAndWeek(companyId: string, weekStart: Date): Promise<Shift[]>;

  /**
   * Persiste una asignación de turno.
   */
  saveAssignment(assignment: ShiftAssignment): Promise<void>;

  /**
   * Elimina una asignación (por ejemplo, cuando un empleado reporta ausencia).
   */
  deleteAssignment(id: string): Promise<void>;

  /**
   * Devuelve todas las asignaciones de un empleado para una empresa.
   * Usado por GetEmployeeCalendarQuery.
   */
  findAssignmentsByEmployee(
    employeeId: string,
    companyId: string,
    from?: Date,
    to?: Date,
  ): Promise<ShiftAssignment[]>;

  /**
   * Devuelve todas las asignaciones de la empresa para una semana.
   * Usado por GetCompanyScheduleQuery.
   */
  findAssignmentsByCompanyAndWeek(
    companyId: string,
    weekStart: Date,
  ): Promise<ShiftAssignment[]>;

  /**
   * Resuelve un ID corto (prefijo de 6 caracteres) al UUID completo del turno.
   * Retorna null si no hay coincidencia única dentro de la empresa.
   */
  resolveShortId(shortId: string, companyId: string): Promise<string | null>;
}

export const SHIFT_REPOSITORY = 'SHIFT_REPOSITORY';
