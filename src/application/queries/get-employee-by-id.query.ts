/**
 * Query: GetEmployeeById
 *
 * Devuelve el empleado por id dentro del tenant actual. Retorna `null` si
 * no existe o fue borrado lógicamente.
 */
export class GetEmployeeByIdQuery {
  constructor(
    public readonly employeeId: string,
    public readonly companyId: string,
  ) {}
}
