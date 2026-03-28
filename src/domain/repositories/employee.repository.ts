import { Employee } from '../aggregates/employee.aggregate';

/**
 * IEmployeeRepository — Port (DDD)
 *
 * Define el contrato que el domain y application layer conocen.
 * La implementación concreta (Supabase) vive en infrastructure.
 *
 * 💡 Dependency Inversion: los handlers dependen de esta interfaz,
 *    no de la implementación de Supabase. Esto hace el dominio
 *    completamente independiente de la base de datos.
 */
export const EMPLOYEE_REPOSITORY = 'EMPLOYEE_REPOSITORY';

export interface IEmployeeRepository {
  save(employee: Employee): Promise<void>;
  findById(id: string, companyId: string): Promise<Employee | null>;
  findByPhone(phone: string, companyId: string): Promise<Employee | null>;
  findAllByCompany(companyId: string, options?: { departmentId?: string; branchId?: string }): Promise<Employee[]>;
  markWhatsappVerified(employeeId: string): Promise<void>;
}
