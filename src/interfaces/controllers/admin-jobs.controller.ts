import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsString, IsUUID, Matches } from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { ScheduleGenerationLockService } from '../../domain/services/schedule-generation-lock.service';

export interface ActiveJobRow {
  companyId: string;
  companyName: string | null;
  weekStart: string;
  acquiredAt: string;
  acquiredBy: string | null;
  ageMs: number;
  stale: boolean;
}

export interface FailedRunRow {
  id: string;
  companyId: string;
  companyName: string | null;
  weekStart: string;
  jobId: string;
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
}

export class ReleaseLockDto {
  @IsUUID('all')
  companyId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart must be YYYY-MM-DD' })
  @IsString()
  weekStart!: string;
}

/**
 * AdminJobsController — health/operational view de jobs cross-tenant.
 *
 *   GET    /admin/jobs/active  → in-flight schedule generations (locks)
 *   GET    /admin/jobs/failed  → últimos 50 runs en estado failed
 *   DELETE /admin/jobs/locks   → force-release un lock (incident recovery)
 *
 * El "active" lee `schedule_generation_locks` (lock = job en vuelo) y
 * marca como stale los que pasaron de STALE_AFTER_MS (5min). El admin
 * puede force-release con DELETE — útil cuando el worker crasheó y
 * dejó el lock sin liberar.
 */
@Controller('admin/jobs')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminJobsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('active')
  async getActive(): Promise<ActiveJobRow[]> {
    const { data, error } = await this.supabase
      .from('schedule_generation_locks')
      .select('company_id, week_start, acquired_at, acquired_by')
      .order('acquired_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      company_id: string;
      week_start: string;
      acquired_at: string;
      acquired_by: string | null;
    }>;
    const companyNames = await this._fetchCompanyNames(
      rows.map((r) => r.company_id),
    );
    const now = Date.now();
    return rows.map((r) => {
      const ageMs = now - new Date(r.acquired_at).getTime();
      return {
        companyId: r.company_id,
        companyName: companyNames.get(r.company_id) ?? null,
        weekStart: r.week_start,
        acquiredAt: r.acquired_at,
        acquiredBy: r.acquired_by,
        ageMs,
        stale: ageMs >= ScheduleGenerationLockService.STALE_AFTER_MS,
      };
    });
  }

  @Get('failed')
  async getFailed(): Promise<FailedRunRow[]> {
    const { data, error } = await this.supabase
      .from('schedule_generation_runs')
      .select(
        'id, company_id, week_start, job_id, duration_ms, error_message, created_at',
      )
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      company_id: string;
      week_start: string;
      job_id: string;
      duration_ms: number;
      error_message: string | null;
      created_at: string;
    }>;
    const companyNames = await this._fetchCompanyNames(
      rows.map((r) => r.company_id),
    );
    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: companyNames.get(r.company_id) ?? null,
      weekStart: r.week_start,
      jobId: r.job_id,
      durationMs: r.duration_ms,
      errorMessage: r.error_message,
      createdAt: r.created_at,
    }));
  }

  /**
   * Borra el lock incondicionalmente. Para incident recovery cuando
   * un worker crashed y dejó el lock sin liberar; el next generate
   * del tenant fallaría con 409 hasta que pase el TTL stale.
   *
   * El delete es directo en la tabla porque `release()` requiere
   * weekStartsOn para normalizar; este force-clear borra por
   * (company_id, week_start) tal como llegaron — lo que existe se va.
   */
  @Delete('locks')
  @HttpCode(HttpStatus.NO_CONTENT)
  async releaseLock(@Body() body: ReleaseLockDto): Promise<void> {
    const { error } = await this.supabase
      .from('schedule_generation_locks')
      .delete()
      .eq('company_id', body.companyId)
      .eq('week_start', body.weekStart);
    if (error) throw new BadRequestException(error.message);
  }

  private async _fetchCompanyNames(
    ids: string[],
  ): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return new Map();
    const { data, error } = await this.supabase
      .from('companies')
      .select('id, name')
      .in('id', unique);
    if (error) return new Map();
    return new Map(
      (data ?? []).map((c) => [c.id as string, (c.name as string) ?? '—']),
    );
  }
}
