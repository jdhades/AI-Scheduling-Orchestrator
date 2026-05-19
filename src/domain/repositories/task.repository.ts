import type { Task } from '../aggregates/task.aggregate';

export const TASK_REPOSITORY = Symbol('TASK_REPOSITORY');

/**
 * ITaskRepository — Port (Domain Layer)
 *
 * CRUD básico de tareas + queries por target. Las 3 vistas
 * (dept/employee/assignment) cubren las pages del frontend:
 *   - /my del empleado: findByEmployeeId(emp) + findByDepartmentId(dept del emp)
 *   - AssignmentEditDialog: findByShiftAssignmentId
 *   - Dashboard manager: findByCompany con filtros
 */
export interface ITaskRepository {
  save(task: Task): Promise<void>;

  deleteById(id: string, companyId: string): Promise<void>;

  findById(id: string, companyId: string): Promise<Task | null>;

  findByCompany(
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]>;

  /** Tareas del depto (solo target=department). */
  findByDepartmentId(
    departmentId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]>;

  /** Tareas del empleado (solo target=employee). */
  findByEmployeeId(
    employeeId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]>;

  /** Tareas atadas a un shift assignment. */
  findByShiftAssignmentId(
    shiftAssignmentId: string,
    companyId: string,
  ): Promise<Task[]>;

  /** Batch lookup para múltiples assignments — usado por el grid /
   * dialog hydration sin N+1 queries. */
  findByShiftAssignmentIds(
    shiftAssignmentIds: string[],
    companyId: string,
  ): Promise<Task[]>;
}
