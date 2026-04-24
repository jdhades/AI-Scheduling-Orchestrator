import type { EmployeePatch } from '../../domain/repositories/employee.repository';

/**
 * Command: UpdateEmployee
 *
 * PATCH parcial sobre un empleado existente. Solo los campos definidos en
 * `patch` se tocan; los `undefined` quedan intactos. Para "limpiar" un
 * campo nullable, pasar `null` explícito.
 */
export class UpdateEmployeeCommand {
  constructor(
    public readonly employeeId: string,
    public readonly companyId: string,
    public readonly patch: EmployeePatch,
  ) {}
}
