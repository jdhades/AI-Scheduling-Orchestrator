/**
 * Command: DeleteEmployee
 *
 * Soft delete: setea `is_active=false` + `deleted_at=NOW()`. El empleado
 * deja de aparecer en las listas de scheduling pero sus filas históricas
 * (assignments, fairness) siguen intactas.
 */
export class DeleteEmployeeCommand {
  constructor(
    public readonly employeeId: string,
    public readonly companyId: string,
  ) {}
}
