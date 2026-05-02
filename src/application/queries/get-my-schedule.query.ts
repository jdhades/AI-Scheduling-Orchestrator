export class GetMyScheduleQuery {
  constructor(
    readonly employeeId: string,
    readonly companyId: string,
    readonly weekStart?: string, // ISO 8601 date (YYYY-MM-DD); defaults to current week
    readonly locale: string = 'es',
    /**
     * Phase 18.6 — manager-on-behalf. Si está seteado, el handler usa
     * los títulos `*_other` ("Horario de {name}...") en lugar del
     * `*_this_week`/`*_that_week` por defecto ("Tu horario...").
     */
    readonly forEmployeeName?: string,
  ) {}
}
