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

  @Get('branches')
  async listBranches(@Query('companyId') companyId: string): Promise<ScopeTarget[]> {
    const { data, error } = await this.supabase
      .from('branches')
      .select('id, name')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as ScopeTarget[];
  }

  @Get('departments')
  async listDepartments(@Query('companyId') companyId: string): Promise<ScopeTarget[]> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('id, name')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as ScopeTarget[];
  }
}
