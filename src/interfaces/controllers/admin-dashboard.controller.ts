import { Controller, Get, Inject, Query } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { ScheduleGenerationLockService } from '../../domain/services/schedule-generation-lock.service';
import { LLMUsageLogger } from '../../infrastructure/observability/llm-usage-logger.service';

export interface QueuePerformanceRow {
  queueName: string;
  completedCount: number;
  failedCount: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  successRate: number;
}

/**
 * Bucket diario para el sparkline 7d. El frontend lo pivota a
 * `Record<queueName, DailyBucket[]>` para dibujar una serie por queue.
 */
export interface QueuePerformanceDailyBucket {
  bucketDate: string; // YYYY-MM-DD
  queueName: string;
  completedCount: number;
  failedCount: number;
}

/**
 * Una fila por (tenant, queue). El frontend agrupa por tenant y muestra
 * top-N para detectar qué companies generan más carga / errores.
 */
export interface QueuePerformanceTenantRow {
  companyId: string;
  companyName: string | null;
  queueName: string;
  completedCount: number;
  failedCount: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

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

  /**
   * GET /admin/dashboard/queue-performance?hours=24
   *
   * Métricas operacionales por queue de pg-boss en la ventana indicada.
   * Latencia P50/P95 (ms) calculada sólo sobre jobs completed; success
   * rate ratio sobre el universo (completed + failed + cancelled).
   *
   * Para dashboards futuros con histórico (sparkline 7d) habría que
   * agregar parámetro de bucket — por ahora un valor agregado alcanza
   * para detectar regresiones operacionales obvias.
   */
  @Get('queue-performance')
  async queuePerformance(
    @Query('hours') hoursStr?: string,
  ): Promise<QueuePerformanceRow[]> {
    const hours = Math.max(
      1,
      Math.min(parseInt(hoursStr ?? '24', 10) || 24, 720),
    );
    const { data, error } = await this.supabase.rpc('queue_performance', {
      hours,
    });
    if (error) {
      throw new Error(`queue_performance RPC failed: ${error.message}`);
    }
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      queueName: row.queue_name as string,
      completedCount: Number(row.completed_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      p50DurationMs:
        row.p50_duration_ms === null || row.p50_duration_ms === undefined
          ? null
          : Number(row.p50_duration_ms),
      p95DurationMs:
        row.p95_duration_ms === null || row.p95_duration_ms === undefined
          ? null
          : Number(row.p95_duration_ms),
      successRate: Number(row.success_rate ?? 0),
    }));
  }

  /**
   * GET /admin/dashboard/queue-performance-daily?days=7
   *
   * Buckets diarios (completed + failed) por queue para los últimos N
   * días. Alimenta el sparkline 7d del dashboard. Default 7d, max 90d.
   *
   * Importante: días sin actividad NO devuelven filas — el frontend
   * rellena con ceros para que el sparkline tenga ancho consistente.
   */
  @Get('queue-performance-daily')
  async queuePerformanceDaily(
    @Query('days') daysStr?: string,
  ): Promise<QueuePerformanceDailyBucket[]> {
    const days = Math.max(1, Math.min(parseInt(daysStr ?? '7', 10) || 7, 90));
    const { data, error } = await this.supabase.rpc('queue_performance_daily', {
      days,
    });
    if (error) {
      throw new Error(`queue_performance_daily RPC failed: ${error.message}`);
    }
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      bucketDate: (row.bucket_date as string | null) ?? '',
      queueName: (row.queue_name as string | null) ?? '',
      completedCount: Number(row.completed_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
    }));
  }

  /**
   * GET /admin/dashboard/queue-performance-by-tenant?hours=24
   *
   * Carga + latencia agrupadas por (tenant, queue) para ver qué companies
   * empujan más jobs / fallan más. Devuelve company_id (null cuando el
   * payload del job no llevaba companyId — debería ser raro) y nombre
   * de la company resuelto via LEFT JOIN companies.
   */
  @Get('queue-performance-by-tenant')
  async queuePerformanceByTenant(
    @Query('hours') hoursStr?: string,
  ): Promise<QueuePerformanceTenantRow[]> {
    const hours = Math.max(
      1,
      Math.min(parseInt(hoursStr ?? '24', 10) || 24, 720),
    );
    const { data, error } = await this.supabase.rpc(
      'queue_performance_by_tenant',
      { hours },
    );
    if (error) {
      throw new Error(
        `queue_performance_by_tenant RPC failed: ${error.message}`,
      );
    }
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      companyId: (row.company_id as string | null) ?? '',
      companyName: (row.company_name as string | null) ?? null,
      queueName: (row.queue_name as string | null) ?? '',
      completedCount: Number(row.completed_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      p50DurationMs:
        row.p50_duration_ms === null || row.p50_duration_ms === undefined
          ? null
          : Number(row.p50_duration_ms),
      p95DurationMs:
        row.p95_duration_ms === null || row.p95_duration_ms === undefined
          ? null
          : Number(row.p95_duration_ms),
    }));
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

  /**
   * GET /admin/dashboard/solver-stats?days=30
   *
   * Agregado sobre `schedule_generation_runs` para mostrar el "health"
   * del scheduler engine en el dashboard:
   *   - total runs en la ventana
   *   - % failed / % cancelled
   *   - avg duration (ms) — sentinel de regression
   *   - avg unfilled_count — sentinel de coverage gaps
   *   - avg llm_total_tokens — costo medio por run
   *
   * Solo cuenta runs con assignments_count NOT NULL (skip pre-LLM
   * cancels que distorsionan las medias).
   */
  @Get('solver-stats')
  async solverStats(
    @Query('days') daysRaw?: string,
  ): Promise<SolverStatsResponse> {
    const days = Math.max(1, Math.min(365, Number(daysRaw) || 30));
    const since = new Date(
      Date.now() - days * 24 * 3600_000,
    ).toISOString();

    const { data, error } = await this.supabase
      .from('schedule_generation_runs')
      .select(
        'status, duration_ms, assignments_count, unfilled_count, llm_total_tokens',
      )
      .gte('created_at', since);

    if (error) {
      return {
        days,
        totalRuns: 0,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        failureRate: 0,
        avgDurationMs: null,
        avgUnfilled: null,
        avgLlmTokens: null,
      };
    }

    type Row = {
      status: 'completed' | 'failed' | 'cancelled';
      duration_ms: number;
      assignments_count: number | null;
      unfilled_count: number | null;
      llm_total_tokens: number | null;
    };
    const rows = (data ?? []) as Row[];
    const total = rows.length;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let durSum = 0;
    let durN = 0;
    let unfSum = 0;
    let unfN = 0;
    let tokSum = 0;
    let tokN = 0;
    for (const r of rows) {
      if (r.status === 'completed') completed++;
      else if (r.status === 'failed') failed++;
      else if (r.status === 'cancelled') cancelled++;
      if (r.assignments_count !== null) {
        durSum += r.duration_ms;
        durN++;
        if (r.unfilled_count !== null) {
          unfSum += r.unfilled_count;
          unfN++;
        }
        if (r.llm_total_tokens !== null) {
          tokSum += r.llm_total_tokens;
          tokN++;
        }
      }
    }

    return {
      days,
      totalRuns: total,
      completedCount: completed,
      failedCount: failed,
      cancelledCount: cancelled,
      failureRate: total > 0 ? failed / total : 0,
      avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
      avgUnfilled: unfN > 0 ? Math.round((unfSum / unfN) * 10) / 10 : null,
      avgLlmTokens: tokN > 0 ? Math.round(tokSum / tokN) : null,
    };
  }

  /**
   * GET /admin/dashboard/tenant-activity?days=30
   *
   * Métricas de actividad del producto:
   *   - recentSignups: tenants creados en la ventana
   *   - activeTenantsBySource: cuántos por `created_via`
   *     (self_signup / invitation / cli_seed)
   *   - inactiveTenants: count de tenants SIN `login_success` en
   *     `auth_audit_log` durante la ventana — churn signal.
   *   - signupsByDay: bucket diario para sparkline
   */
  @Get('tenant-activity')
  async tenantActivity(
    @Query('days') daysRaw?: string,
  ): Promise<TenantActivityResponse> {
    const days = Math.max(1, Math.min(365, Number(daysRaw) || 30));
    const since = new Date(
      Date.now() - days * 24 * 3600_000,
    ).toISOString();

    const [allTenantsRes, recentSignupsRes, activeLoginsRes] =
      await Promise.all([
        this.supabase
          .from('companies')
          .select('id, created_via, created_at'),
        this.supabase
          .from('companies')
          .select('id, name, created_via, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(50),
        this.supabase
          .from('auth_audit_log')
          .select('company_id')
          .eq('event', 'login_success')
          .gte('created_at', since),
      ]);

    type Tenant = {
      id: string;
      created_via: string | null;
      created_at: string;
    };
    type Signup = {
      id: string;
      name: string | null;
      created_via: string | null;
      created_at: string;
    };
    const allTenants = (allTenantsRes.data ?? []) as Tenant[];
    const signups = (recentSignupsRes.data ?? []) as Signup[];
    const activeIds = new Set(
      ((activeLoginsRes.data ?? []) as Array<{ company_id: string }>).map(
        (r) => r.company_id,
      ),
    );

    // Activity breakdown by source
    const bySource: Record<string, number> = {};
    for (const t of allTenants) {
      const src = t.created_via ?? 'unknown';
      bySource[src] = (bySource[src] ?? 0) + 1;
    }

    // Signups grouped by day for sparkline
    const byDay = new Map<string, number>();
    for (const s of signups) {
      const day = s.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    const signupsByDay = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return {
      days,
      recentSignups: {
        count: signups.length,
        rows: signups.map((s) => ({
          id: s.id,
          name: s.name ?? '—',
          createdVia: s.created_via ?? 'unknown',
          createdAt: s.created_at,
        })),
      },
      activeTenantsBySource: bySource,
      inactiveTenants: allTenants.filter((t) => !activeIds.has(t.id)).length,
      totalTenants: allTenants.length,
      signupsByDay,
    };
  }
}

export interface SolverStatsResponse {
  days: number;
  totalRuns: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  failureRate: number;
  avgDurationMs: number | null;
  avgUnfilled: number | null;
  avgLlmTokens: number | null;
}

export interface TenantActivityResponse {
  days: number;
  recentSignups: {
    count: number;
    rows: Array<{
      id: string;
      name: string;
      createdVia: string;
      createdAt: string;
    }>;
  };
  activeTenantsBySource: Record<string, number>;
  inactiveTenants: number;
  totalTenants: number;
  signupsByDay: Array<{ date: string; count: number }>;
}

function uniq(arr: Array<string | null | undefined>): string[] {
  return Array.from(new Set(arr.filter((s): s is string => !!s)));
}
