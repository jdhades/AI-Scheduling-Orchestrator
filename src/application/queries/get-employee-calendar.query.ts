/**
 * Query: GetEmployeeCalendar
 *
 * Encapsula los parámetros para consultar el calendario de turnos
 * de un empleado en un rango de fechas.
 *
 * 💡 CQRS: Las queries son Read-Only. Nunca modifican estado.
 *         Se optimizan para lectura directa sin pasar por el domain.
 */
export class GetEmployeeCalendarQuery {
    constructor(
        public readonly employeeId: string,
        public readonly companyId: string,
        public readonly from: Date,
        public readonly to: Date,
    ) { }
}
