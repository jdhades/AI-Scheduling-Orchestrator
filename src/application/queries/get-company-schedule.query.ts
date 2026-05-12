import { IQuery } from '@nestjs/cqrs';

/**
 * GetCompanyScheduleQuery
 *
 * Recupera todos los turnos de la empresa para una semana con sus asignaciones.
 */
export class GetCompanyScheduleQuery implements IQuery {
  constructor(
    public readonly companyId: string,
    /** ISO date del lunes de la semana (YYYY-MM-DD) */
    public readonly weekStart: string,
    /** Opcional — filtra assignments al departamento dado. */
    public readonly departmentId?: string,
    /**
     * Opcional — filtra assignments a un solo empleado.
     * Usado por la vista del empleado (`/my` PR 8) que solo necesita
     * sus propios shifts. Backend hace el filter post-fetch (cliente
     * Supabase con service_role bypassa RLS).
     */
    public readonly employeeId?: string,
  ) {}
}
