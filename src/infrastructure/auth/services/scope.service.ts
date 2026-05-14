import {
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '../auth-context';

/**
 * ScopeService — utilidades app-layer para validar/filtrar por scope
 * cuando el SQL helper `auth.user_visible_dept_ids()` no es práctico
 * (queries con service_role bypass de RLS, validación pre-mutation, etc.).
 *
 * Owners siempre tienen scope full (devuelve `null` = sin filtro).
 * Managers reciben la unión de manager_scopes (branches + departments).
 * Employees ven solo su propio depto.
 */
@Injectable()
export class ScopeService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Devuelve la lista de department IDs visibles al user, o `null` si
   * el user tiene full scope (owner). Use `null` como "no filtrar".
   *
   * Manager flow: union de
   *   - manager_scopes.scope_type='department' (depts directos)
   *   - manager_scopes.scope_type='branch' → todos los depts de esas branches
   *
   * Employee flow: solo su `employees.department_id` (si tiene).
   */
  async visibleDepartmentIds(user: AuthContext): Promise<string[] | null> {
    if (user.role === 'owner') return null;
    if (!user.employeeId) return [];

    if (user.role === 'employee') {
      return user.departmentId ? [user.departmentId] : [];
    }

    // Manager: unión de scopes
    const { data: scopes, error: scopesErr } = await this.supabase
      .from('manager_scopes')
      .select('scope_type, scope_id')
      .eq('employee_id', user.employeeId);
    if (scopesErr) throw scopesErr;

    const directDepts = (scopes ?? [])
      .filter((s) => s.scope_type === 'department')
      .map((s) => s.scope_id as string);
    const branchIds = (scopes ?? [])
      .filter((s) => s.scope_type === 'branch')
      .map((s) => s.scope_id as string);

    if (branchIds.length === 0) return directDepts;

    const { data: branchDepts, error: bErr } = await this.supabase
      .from('departments')
      .select('id')
      .in('branch_id', branchIds);
    if (bErr) throw bErr;
    const fromBranches = (branchDepts ?? []).map((r) => r.id as string);

    // Dedupe
    return Array.from(new Set([...directDepts, ...fromBranches]));
  }

  /**
   * Throw 403 si el dept no está en el scope del user. Owner siempre pasa.
   * Para endpoints write que reciben un `dept_id` (creación de empleado,
   * generación de schedule de un depto específico, etc.).
   */
  async assertDeptInScope(user: AuthContext, deptId: string): Promise<void> {
    if (user.role === 'owner') return;
    const visible = await this.visibleDepartmentIds(user);
    if (visible === null) return; // defensive — should be owner
    if (!visible.includes(deptId)) {
      throw new ForbiddenException(
        `Resource is not in your scope (department ${deptId})`,
      );
    }
  }

  /**
   * Lista de branches visibles al user. Para managers, solo las branches
   * a las que están asignados directamente. Para owner, devuelve null
   * (sin filtro). Used para BranchesPage list.
   */
  async visibleBranchIds(user: AuthContext): Promise<string[] | null> {
    if (user.role === 'owner') return null;
    if (!user.employeeId) return [];

    // Branches que el manager tiene directamente Y branches de sus
    // depts asignados directos.
    const { data: scopes } = await this.supabase
      .from('manager_scopes')
      .select('scope_type, scope_id')
      .eq('employee_id', user.employeeId);

    const directBranches = (scopes ?? [])
      .filter((s) => s.scope_type === 'branch')
      .map((s) => s.scope_id as string);
    const directDepts = (scopes ?? [])
      .filter((s) => s.scope_type === 'department')
      .map((s) => s.scope_id as string);

    if (directDepts.length === 0) return directBranches;
    const { data: deptBranches } = await this.supabase
      .from('departments')
      .select('branch_id')
      .in('id', directDepts);
    const fromDepts = (deptBranches ?? []).map((r) => r.branch_id as string);

    return Array.from(new Set([...directBranches, ...fromDepts]));
  }
}
