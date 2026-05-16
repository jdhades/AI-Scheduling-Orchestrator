import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

interface ScopeTarget {
  id: string;
  name: string;
}

/**
 * ScopeTargetsController — read-only listings de branches y departments.
 *
 * Phase 14.3 — el frontend necesita estas listas para poder crear policies
 * con scope=branch / scope=department (selector con nombres). Hoy no hay
 * controllers full CRUD para estas entidades; este controller cubre el
 * gap mínimo.
 *
 * NO es CQRS porque son queries triviales con company_id; agregarlo sería
 * sobre-ingeniería. Si se vuelven entidades de primera clase con CRUD,
 * migrar a su propio módulo.
 */
@Controller()
export class ScopeTargetsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  // GET /branches movido a BranchesController — shape extendido
  // (id, name, timezone, departmentCount). Quedaba acá como duplicado
  // colisionando con la nueva ruta.

  @Get('departments')
  async listDepartments(
    @CurrentCompany() companyId: string,
  ): Promise<DepartmentDto[]> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('id, name, branch_id, manager_employee_id, swap_auto_approve')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((d: Record<string, unknown>) => ({
      id: d.id as string,
      name: d.name as string,
      branchId: d.branch_id as string,
      managerEmployeeId: (d.manager_employee_id as string | null) ?? null,
      swapAutoApprove: (d.swap_auto_approve as boolean | null) ?? false,
    }));
  }
}

interface DepartmentDto {
  id: string;
  name: string;
  branchId: string;
  /** Employee designado como manager del depto. null = sin asignar. */
  managerEmployeeId: string | null;
  /** Phase 15.3 — si true, swap requests del depto se auto-aprueban. */
  swapAutoApprove: boolean;
}
