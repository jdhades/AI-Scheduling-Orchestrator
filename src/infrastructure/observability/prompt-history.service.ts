import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PromptHistoryRecord {
  companyId: string | null;
  operation: string;
  promptText: string;
  responseText: string | null;
  modelUsed: string | null;
  tokensUsed: number | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  jobId: string | null;
}

/**
 * PromptHistoryService
 *
 * Persiste cada llamada al LLM (prompt + response + metadata) en
 * `llm_prompt_history`. Fire-and-forget: nunca bloquea el flow del
 * caller. Si la persistencia falla, se loguea como WARN pero el
 * caller no se entera.
 *
 * Wireado vía `LlmResolverService` (proxy automático). Consumers que
 * todavía no usan el resolver pueden llamar `record(...)` directo.
 */
@Injectable()
export class PromptHistoryService {
  private readonly logger = new Logger(PromptHistoryService.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Persiste un registro. NO await en el caller — `record(...)` se
   * dispara y olvida; cualquier error se loguea pero no se propaga.
   */
  record(record: PromptHistoryRecord): void {
    void this._persist(record).catch((err) => {
      this.logger.warn(
        `PromptHistoryService: failed to persist record (${record.operation}): ${(err as Error).message}`,
      );
    });
  }

  private async _persist(record: PromptHistoryRecord): Promise<void> {
    const { error } = await this.supabase.from('llm_prompt_history').insert({
      company_id: record.companyId,
      operation: record.operation,
      prompt_text: record.promptText,
      response_text: record.responseText,
      model_used: record.modelUsed,
      tokens_used: record.tokensUsed,
      duration_ms: record.durationMs,
      success: record.success,
      error_message: record.errorMessage,
      job_id: record.jobId,
    });
    if (error) {
      throw new Error(error.message);
    }
  }
}
