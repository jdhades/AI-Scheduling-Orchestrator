import { Controller, Get, Inject, Query } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Roles } from '../../infrastructure/auth/decorators/roles.decorator';

interface AuditLogRow {
  id: string;
  companyId: string | null;
  authUserId: string | null;
  employeeId: string | null;
  event: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * AuditController
 *
 * GET /auth/audit-log — manager-only. Devuelve los eventos del
 * tenant. Filtros opcionales:
 *   ?event=permission_denied
 *   ?since=2026-05-01T00:00:00Z
 *   ?limit=50  (default 50, max 200)
 *
 * Sin paginación con cursor — para histórico amplio, exportar a SIEM
 * (PR futuro). Acá foco en últimas N entradas para el dashboard.
 */
@Controller('auth/audit-log')
export class AuditController {
  private static readonly MAX_LIMIT = 200;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  @Roles('manager')
  async list(
    @CurrentCompany() companyId: string,
    @Query('event') event?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogRow[]> {
    const n = Math.min(
      Math.max(parseInt(limit ?? '50', 10) || 50, 1),
      AuditController.MAX_LIMIT,
    );
    let query = this.supabase
      .from('auth_audit_log')
      .select(
        'id, company_id, auth_user_id, employee_id, event, ip_address, user_agent, metadata, created_at',
      )
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(n);
    if (event) query = query.eq('event', event);
    if (since) query = query.gte('created_at', since);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []).map(this.toRow);
  }

  private toRow = (r: Record<string, unknown>): AuditLogRow => ({
    id: r.id as string,
    companyId: (r.company_id as string | null) ?? null,
    authUserId: (r.auth_user_id as string | null) ?? null,
    employeeId: (r.employee_id as string | null) ?? null,
    event: r.event as string,
    ipAddress: (r.ip_address as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as string,
  });
}
