import type { ShiftMembership } from '../aggregates/shift-membership.aggregate';

export const SHIFT_MEMBERSHIP_REPOSITORY = Symbol('SHIFT_MEMBERSHIP_REPOSITORY');

/**
 * IShiftMembershipRepository — port de dominio
 *
 * Fuente de verdad para "qué empleado pertenece a qué shift_template
 * durante qué rango de fechas". Alimenta al ShiftSlotGeneratorService
 * al momento de generar el horario de una semana.
 */
export interface IShiftMembershipRepository {
  /** Guarda o actualiza una membresía (upsert por `id`). */
  save(membership: ShiftMembership): Promise<void>;

  /** Borra una membresía por id. */
  delete(id: string, companyId: string): Promise<void>;

  /** Encuentra una membresía específica por id. */
  findById(id: string, companyId: string): Promise<ShiftMembership | null>;

  /**
   * Retorna todas las membresías activas en la fecha dada (inclusive).
   * Filtro: effective_from <= date AND (effective_until IS NULL OR effective_until >= date).
   */
  findActiveOnDate(companyId: string, dateISO: string): Promise<ShiftMembership[]>;

  /**
   * Retorna todas las membresías activas en cualquier día dentro de un rango
   * (inclusive). Útil para cargar las relevantes de una semana de una sola query.
   */
  findActiveInRange(
    companyId: string,
    fromISO: string,
    toISO: string,
  ): Promise<ShiftMembership[]>;

  /** Todas las membresías de un empleado (históricas + futuras). */
  findByEmployee(employeeId: string, companyId: string): Promise<ShiftMembership[]>;

  /** Todas las membresías asignadas a un template concreto. */
  findByTemplate(templateId: string, companyId: string): Promise<ShiftMembership[]>;
}
