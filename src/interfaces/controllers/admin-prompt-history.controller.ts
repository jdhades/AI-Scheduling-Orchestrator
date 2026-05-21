import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

export interface PromptHistoryListRow {
  id: string;
  companyId: string | null;
  companyName: string | null;
  operation: string;
  modelUsed: string | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  jobId: string | null;
  createdAt: string;
  /** Primeros 120 chars del prompt para preview (lista). */
  promptPreview: string;
}

export interface PromptHistoryDetail extends PromptHistoryListRow {
  promptText: string;
  responseText: string | null;
}

/**
 * AdminPromptHistoryController — viewer cross-tenant del log de prompts
 * LLM. Solo platform admins; cualquier user no-admin recibe 403.
 *
 *   GET /admin/llm-prompts?companyId=...&operation=...&success=...&limit=...
 *   GET /admin/llm-prompts/:id  → detalle full (prompt + response)
 *
 * El listado devuelve un preview corto del prompt; el detalle trae
 * todo. Cualquier filtro es opcional.
 */
@Controller('admin/llm-prompts')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminPromptHistoryController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  async list(
    @Query('companyId') companyId?: string,
    @Query('operation') operation?: string,
    @Query('success') success?: string,
    @Query('limit') limitParam?: string,
  ): Promise<PromptHistoryListRow[]> {
    const limit = Math.min(
      Number.isFinite(Number(limitParam)) ? Number(limitParam) : 50,
      200,
    );
    let q = this.supabase
      .from('llm_prompt_history')
      .select(
        'id, company_id, operation, prompt_text, model_used, duration_ms, success, error_message, job_id, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (companyId) q = q.eq('company_id', companyId);
    if (operation) q = q.eq('operation', operation);
    if (success === 'true') q = q.eq('success', true);
    if (success === 'false') q = q.eq('success', false);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      company_id: string | null;
      operation: string;
      prompt_text: string;
      model_used: string | null;
      duration_ms: number | null;
      success: boolean;
      error_message: string | null;
      job_id: string | null;
      created_at: string;
    }>;

    // Resolver nombres de companies en batch (evitar N+1).
    const companyIds = Array.from(
      new Set(rows.map((r) => r.company_id).filter((id): id is string => !!id)),
    );
    const namesByCompany = await this._fetchCompanyNames(companyIds);

    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_id ? (namesByCompany.get(r.company_id) ?? null) : null,
      operation: r.operation,
      modelUsed: r.model_used,
      durationMs: r.duration_ms,
      success: r.success,
      errorMessage: r.error_message,
      jobId: r.job_id,
      createdAt: r.created_at,
      promptPreview:
        r.prompt_text.length > 120
          ? r.prompt_text.slice(0, 120) + '…'
          : r.prompt_text,
    }));
  }

  @Get(':id')
  async getDetail(@Param('id') id: string): Promise<PromptHistoryDetail> {
    const { data, error } = await this.supabase
      .from('llm_prompt_history')
      .select(
        'id, company_id, operation, prompt_text, response_text, model_used, duration_ms, success, error_message, job_id, created_at',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Prompt history record not found');
    const namesByCompany = await this._fetchCompanyNames(
      data.company_id ? [data.company_id as string] : [],
    );
    return {
      id: data.id as string,
      companyId: (data.company_id as string | null) ?? null,
      companyName: data.company_id
        ? (namesByCompany.get(data.company_id as string) ?? null)
        : null,
      operation: data.operation as string,
      modelUsed: (data.model_used as string | null) ?? null,
      durationMs: (data.duration_ms as number | null) ?? null,
      success: data.success as boolean,
      errorMessage: (data.error_message as string | null) ?? null,
      jobId: (data.job_id as string | null) ?? null,
      createdAt: data.created_at as string,
      promptPreview: '', // no aplica en detalle
      promptText: data.prompt_text as string,
      responseText: (data.response_text as string | null) ?? null,
    };
  }

  private async _fetchCompanyNames(ids: string[]): Promise<Map<string, string>> {
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
}
