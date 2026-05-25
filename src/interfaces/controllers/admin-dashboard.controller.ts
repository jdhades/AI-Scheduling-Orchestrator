import { Controller, Get, Inject } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { ScheduleGenerationLockService } from '../../domain/services/schedule-generation-lock.service';
import { LLMUsageLogger } from '../../infrastructure/observability/llm-usage-logger.service';

export interface AdminDashboardOverview {
  tenants: {
    total: number;
    trialing: number;
    active: number;
    pastDue: number;
    canceled: number;
  };
  jobs: {
    active: number;
    stale: number;
    failed24h: number;
  };
  llm: {
    last30dCalls: number;
    last30dTokens: number;
    last30dPromptsLogged: number;
    failedPrompts24h: number;
  };
  recentAuthFailures: Array<{
    event: string;
    companyName: string | null;
    employeeName: string | null;
    createdAt: string;
  }>;
}

/**
 * AdminDashboardController — overview cross-tenant del sistema. Endpoint
 * único agregado por el landing /admin: stats de tenants, jobs, LLM y
 * eventos de auth fallidos recientes.
 *
 * GET /admin/dashboard/overview → todos los stats en un solo round-trip.
 */
@Controller('admin/dashboard')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminDashboardController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly llmLogger: LLMUsageLogger,
  ) {}

  @Get('overview')
  async overview(): Promise<AdminDashboardOverview> {
    const now = Date.now();
    const yesterdayIso = new Date(now - 24 * 3600_000).toISOString();
    const [
      tenants,
      activeLocks,
      failed24hRes,
      llm30d,
      promptCounts,
      recentAuthFailRes,
    ] = await Promise.all([
      this.supabase.from('companies').select('subscription_status'),
      this.supabase.from('schedule_generation_locks').select('acquired_at'),
      this.supabase
        .from('schedule_generation_runs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('created_at', yesterdayIso),
      this.llmLogger.summary(30),
      this._countPrompts(yesterdayIso),
      this.supabase
        .from('auth_audit_log')
        .select('event, company_id, employee_id, created_at')
        .in('event', ['login_fail', 'permission_denied', 'session_invalidated'])
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    // Tenants by status
    const tenantStatusCounts = {
      trialing: 0,
      active: 0,
      pastDue: 0,
      canceled: 0,
    };
    for (const row of (tenants.data ?? []) as Array<{
      subscription_status: string;
    }>) {
      switch (row.subscription_status) {
        case 'trialing':
          tenantStatusCounts.trialing++;
          break;
        case 'active':
          tenantStatusCounts.active++;
          break;
        case 'past_due':
          tenantStatusCounts.pastDue++;
          break;
        case 'canceled':
          tenantStatusCounts.canceled++;
          break;
      }
    }

    // Locks: active = total, stale = aged > STALE_AFTER_MS
    const locks = (activeLocks.data ?? []) as Array<{ acquired_at: string }>;
    const staleCount = locks.filter(
      (l) =>
        now - new Date(l.acquired_at).getTime() >=
        ScheduleGenerationLockService.STALE_AFTER_MS,
    ).length;

    // Recent auth failures — enrich with company/employee names
    const failRows = (recentAuthFailRes.data ?? []) as Array<{
      event: string;
      company_id: string | null;
      employee_id: string | null;
      created_at: string;
    }>;
    const cIds = uniq(failRows.map((r) => r.company_id));
    const eIds = uniq(failRows.map((r) => r.employee_id));
    const [companyNames, employeeNames] = await Promise.all([
      this._namesFor('companies', cIds),
      this._namesFor('employees', eIds),
    ]);
    const recentAuthFailures = failRows.map((r) => ({
      event: r.event,
      companyName: r.company_id
        ? (companyNames.get(r.company_id) ?? null)
        : null,
      employeeName: r.employee_id
        ? (employeeNames.get(r.employee_id) ?? null)
        : null,
      createdAt: r.created_at,
    }));

    return {
      tenants: {
        total: (tenants.data ?? []).length,
        ...tenantStatusCounts,
      },
      jobs: {
        active: locks.length,
        stale: staleCount,
        failed24h: failed24hRes.count ?? 0,
      },
      llm: {
        last30dCalls: llm30d.totals.calls,
        last30dTokens: llm30d.totals.totalTokens,
        last30dPromptsLogged: promptCounts.total,
        failedPrompts24h: promptCounts.failed24h,
      },
      recentAuthFailures,
    };
  }

  private async _countPrompts(
    yesterdayIso: string,
  ): Promise<{ total: number; failed24h: number }> {
    const [totalRes, failedRes] = await Promise.all([
      this.supabase
        .from('llm_prompt_history')
        .select('id', { count: 'exact', head: true })
        .gte(
          'created_at',
          new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
        ),
      this.supabase
        .from('llm_prompt_history')
        .select('id', { count: 'exact', head: true })
        .eq('success', false)
        .gte('created_at', yesterdayIso),
    ]);
    return {
      total: totalRes.count ?? 0,
      failed24h: failedRes.count ?? 0,
    };
  }

  private async _namesFor(
    table: 'companies' | 'employees',
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase
      .from(table)
      .select('id, name')
      .in('id', ids);
    if (error) return new Map();
    return new Map(
      (data ?? []).map((r) => [r.id as string, (r.name as string) ?? '—']),
    );
  }
}

function uniq(arr: Array<string | null | undefined>): string[] {
  return Array.from(new Set(arr.filter((s): s is string => !!s)));
}
