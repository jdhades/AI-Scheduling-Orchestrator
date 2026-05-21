import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

export interface AuthAuditRow {
  id: string;
  companyId: string | null;
  companyName: string | null;
  authUserId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  event: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface EntityAuditRow {
  id: string;
  companyId: string;
  companyName: string | null;
  entityType: 'shift_assignment' | 'shift_template' | 'employee' | 'company_policy';
  entityId: string;
  action: 'create' | 'update' | 'delete';
  changes: Record<string, { before: unknown; after: unknown }>;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  actorEmployeeName: string | null;
  changedAt: string;
}

/**
 * AdminAuditController — viewers cross-tenant de los 2 audit logs:
 *   GET /admin/audit/auth?companyId=&event=&limit=
 *   GET /admin/audit/entities?companyId=&entityType=&action=&limit=
 *
 * Ambas tablas ya existen (auth_audit_log, entity_audit_log). Aquí solo
 * agregamos un read-side para soporte. Filtros opcionales; default
 * limit=100, cap 500. Resuelvemos nombres de companies / employees en
 * batch para no hacer N+1.
 */
@Controller('admin/audit')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminAuditController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('auth')
  async listAuthEvents(
    @Query('companyId') companyId?: string,
    @Query('event') event?: string,
    @Query('limit') limitParam?: string,
  ): Promise<AuthAuditRow[]> {
    const limit = this._parseLimit(limitParam);
    let q = this.supabase
      .from('auth_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (companyId) q = q.eq('company_id', companyId);
    if (event) q = q.eq('event', event);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      company_id: string | null;
      auth_user_id: string | null;
      employee_id: string | null;
      event: string;
      ip_address: string | null;
      user_agent: string | null;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }>;

    const companyIds = uniqIds(rows.map((r) => r.company_id));
    const employeeIds = uniqIds(rows.map((r) => r.employee_id));
    const [companyNames, employeeNames] = await Promise.all([
      this._fetchCompanyNames(companyIds),
      this._fetchEmployeeNames(employeeIds),
    ]);

    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_id ? (companyNames.get(r.company_id) ?? null) : null,
      authUserId: r.auth_user_id,
      employeeId: r.employee_id,
      employeeName: r.employee_id ? (employeeNames.get(r.employee_id) ?? null) : null,
      event: r.event,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  }

  @Get('entities')
  async listEntityChanges(
    @Query('companyId') companyId?: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('limit') limitParam?: string,
  ): Promise<EntityAuditRow[]> {
    const limit = this._parseLimit(limitParam);
    let q = this.supabase
      .from('entity_audit_log')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit);
    if (companyId) q = q.eq('company_id', companyId);
    if (entityType) q = q.eq('entity_type', entityType);
    if (action) q = q.eq('action', action);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      company_id: string;
      entity_type: EntityAuditRow['entityType'];
      entity_id: string;
      action: EntityAuditRow['action'];
      changes: EntityAuditRow['changes'];
      actor_user_id: string | null;
      actor_employee_id: string | null;
      changed_at: string;
    }>;

    const companyIds = uniqIds(rows.map((r) => r.company_id));
    const employeeIds = uniqIds(rows.map((r) => r.actor_employee_id));
    const [companyNames, employeeNames] = await Promise.all([
      this._fetchCompanyNames(companyIds),
      this._fetchEmployeeNames(employeeIds),
    ]);

    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: companyNames.get(r.company_id) ?? null,
      entityType: r.entity_type,
      entityId: r.entity_id,
      action: r.action,
      changes: r.changes,
      actorUserId: r.actor_user_id,
      actorEmployeeId: r.actor_employee_id,
      actorEmployeeName: r.actor_employee_id
        ? (employeeNames.get(r.actor_employee_id) ?? null)
        : null,
      changedAt: r.changed_at,
    }));
  }

  private _parseLimit(limitParam: string | undefined): number {
    const parsed = Number(limitParam);
    const fallback = 100;
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, 500);
  }

  private async _fetchCompanyNames(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase
      .from('companies')
      .select('id, name')
      .in('id', ids);
    if (error) return new Map();
    return new Map(
      (data ?? []).map((c) => [c.id as string, (c.name as string) ?? '—']),
    );
  }

  private async _fetchEmployeeNames(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, name')
      .in('id', ids);
    if (error) return new Map();
    return new Map(
      (data ?? []).map((e) => [e.id as string, (e.name as string) ?? '—']),
    );
  }
}

function uniqIds(arr: Array<string | null | undefined>): string[] {
  return Array.from(new Set(arr.filter((s): s is string => !!s)));
}
