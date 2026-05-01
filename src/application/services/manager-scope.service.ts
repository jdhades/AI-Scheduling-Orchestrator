import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ManagerScopeService — resuelve "qué empleados están bajo la responsabilidad
 * de un manager" para los filtros de approvals.
 *
 * Phase 15.2 — la regla, deliberadamente simple:
 *   Un manager X "ve" las approvals de empleados que pertenecen a un
 *   departamento donde:
 *     - departments.manager_employee_id = X      (su depto explícitamente),
 *     - O bien manager_employee_id IS NULL       (depto sin manager → fallback
 *                                                 a triage común para que no
 *                                                 se pierdan solicitudes).
 *
 * Empleados sin `department_id` (managers tenant-wide, etc.) NO entran en
 * el scope de ningún manager — sus solicitudes (raras, en general no
 * existirán) caen al fallback de "ver todo" cuando el frontend no pasa el
 * filtro.
 *
 * El método devuelve un Set para hacer el filter en memoria O(1) por fila;
 * la lista de approvals nunca es enorme.
 */
@Injectable()
export class ManagerScopeService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async getEmployeeIdsForManager(
    companyId: string,
    managerEmployeeId: string,
  ): Promise<Set<string>> {
    // 1. Departamentos del tenant cuyo manager es X o están sin asignar.
    const depts = await this.supabase
      .from('departments')
      .select('id, manager_employee_id')
      .eq('company_id', companyId)
      .or(
        `manager_employee_id.eq.${managerEmployeeId},manager_employee_id.is.null`,
      );
    if (depts.error) {
      throw new Error(
        `ManagerScopeService.getEmployeeIdsForManager failed (departments): ${depts.error.message}`,
      );
    }
    const deptIds = (depts.data ?? []).map((d) => d.id as string);
    if (deptIds.length === 0) return new Set();

    // 2. Empleados del tenant en esos departamentos.
    const emps = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .in('department_id', deptIds);
    if (emps.error) {
      throw new Error(
        `ManagerScopeService.getEmployeeIdsForManager failed (employees): ${emps.error.message}`,
      );
    }
    return new Set((emps.data ?? []).map((e) => e.id as string));
  }
}
