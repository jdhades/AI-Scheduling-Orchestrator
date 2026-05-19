import type { Task } from '../aggregates/task.aggregate';

export const TASK_REPOSITORY = Symbol('TASK_REPOSITORY');

/**
 * ITaskRepository — Port (Domain Layer)
 *
 * CRUD básico de tareas + queries por target (template | employee).
 */
export interface ITaskRepository {
  save(task: Task): Promise<void>;

  deleteById(id: string, companyId: string): Promise<void>;

  findById(id: string, companyId: string): Promise<Task | null>;

  findByCompany(
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]>;

  /** Tareas del template (target=template). Cualquier assignment con
   * ese templateId hereda este set. */
  findByTemplateId(
    templateId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]>;

  /** Tareas del empleado (target=employee). */
  findByEmployeeId(
    employeeId: string,
    companyId: string,
    filters?: { isDone?: boolean },
  ): Promise<Task[]>;
}
