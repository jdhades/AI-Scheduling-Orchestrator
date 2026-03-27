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
  ) {}
}
