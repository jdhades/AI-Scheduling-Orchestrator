import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordRunInput {
  companyId: string;
  weekStart: string; // YYYY-MM-DD
  jobId: string;
  status: 'completed' | 'failed' | 'cancelled';
  source: 'http' | 'whatsapp';
  durationMs: number;
  assignmentsCount?: number | null;
  unfilledCount?: number | null;
  llm?: {
    calls: number;
    prompt: number;
    completion: number;
    total: number;
  } | null;
  explanation?: string | null;
  warnings?: string[] | null;
  errorMessage?: string | null;
}

export interface ScheduleGenerationRunRow {
  id: string;
  companyId: string;
  weekStart: string;
  jobId: string;
  status: 'completed' | 'failed' | 'cancelled';
  source: 'http' | 'whatsapp';
  durationMs: number;
  assignmentsCount: number | null;
  unfilledCount: number | null;
  llmCalls: number | null;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  llmTotalTokens: number | null;
  explanation: string | null;
  warnings: string[] | null;
  errorMessage: string | null;
  createdAt: string;
}

/**
 * ScheduleGenerationRunsService
 *
 * Persiste cada run terminado de `schedule.generate` en
 * `schedule_generation_runs`. Read-side para el dashboard
 * (`listRecent`) y para la página `/scheduling/generate` (post-mortem
 * por semana).
 *
 * Side effect-only en el path de escritura: si el insert falla, se
 * loguea pero no rompe el flow del worker — el job ya está terminado
 * desde el lado de pg-boss.
 */
@Injectable()
export class ScheduleGenerationRunsService {
  private readonly logger = new Logger(ScheduleGenerationRunsService.name);

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  async record(input: RecordRunInput): Promise<void> {
    const { error } = await this.supabase
      .from('schedule_generation_runs')
      .insert({
        company_id: input.companyId,
        week_start: input.weekStart,
        job_id: input.jobId,
        status: input.status,
        source: input.source,
        duration_ms: input.durationMs,
        assignments_count: input.assignmentsCount ?? null,
        unfilled_count: input.unfilledCount ?? null,
        llm_calls: input.llm?.calls ?? null,
        llm_prompt_tokens: input.llm?.prompt ?? null,
        llm_completion_tokens: input.llm?.completion ?? null,
        llm_total_tokens: input.llm?.total ?? null,
        explanation: input.explanation ?? null,
        warnings: input.warnings ?? null,
        error_message: input.errorMessage ?? null,
      });
    if (error) {
      this.logger.warn(
        `Failed to record generation run job=${input.jobId}: ${error.message}`,
      );
    }
  }

  /**
   * Lista los últimos `limit` runs del tenant ordenados por
   * `created_at DESC`. Usado por el dashboard para mostrar histórico.
   */
  async listRecent(
    companyId: string,
    limit: number,
  ): Promise<ScheduleGenerationRunRow[]> {
    const { data, error } = await this.supabase
      .from('schedule_generation_runs')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      this.logger.error(
        `Failed to list runs for company=${companyId}: ${error.message}`,
      );
      return [];
    }
    return (data ?? []).map((r): ScheduleGenerationRunRow => ({
      id: r.id,
      companyId: r.company_id,
      weekStart: r.week_start,
      jobId: r.job_id,
      status: r.status,
      source: r.source,
      durationMs: r.duration_ms,
      assignmentsCount: r.assignments_count,
      unfilledCount: r.unfilled_count,
      llmCalls: r.llm_calls,
      llmPromptTokens: r.llm_prompt_tokens,
      llmCompletionTokens: r.llm_completion_tokens,
      llmTotalTokens: r.llm_total_tokens,
      explanation: r.explanation,
      warnings: r.warnings,
      errorMessage: r.error_message,
      createdAt: r.created_at,
    }));
  }
}
