import { Inject, Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface LLMUsageContext {
  /** Subsistema que origina la call (ej. 'schedule_generation', 'whatsapp_classify'). */
  operation: string;
  /** Tenant — opcional para contextos sin company aún (clasificadores standalone). */
  companyId?: string | null;
  /** Si la call vive dentro de un schedule.generate, link al job_id. */
  jobId?: string | null;
}

export interface RecordCallInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs?: number | null;
}

export interface UsageSummary {
  /** Totales globales del rango. */
  totals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Breakdown por operation. */
  byOperation: Array<{
    operation: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
  /** Breakdown por modelo (qwen3.6-plus, gemini-2.0-flash, etc). */
  byModel: Array<{
    model: string;
    calls: number;
    totalTokens: number;
  }>;
}

/**
 * LLMUsageLogger
 *
 * Persiste cada llamada al LLM en `llm_usage_log` para alimentar el
 * dashboard de costo. Complementa `LLMUsageTracker` (in-memory) — el
 * tracker sigue siendo útil para acumular dentro de un scope (un
 * schedule.generate completo), este logger es la fuente de verdad
 * permanente.
 *
 * Uso:
 *   - Caller envuelve el flujo en `withContext({operation, companyId})`.
 *   - Cada LLM service (Qwen, Gemini, LocalLLM) llama `record(...)` con
 *     model + tokens al recibir respuesta.
 *   - El logger lee el contexto del ALS y persiste la fila.
 *
 * Side-effect-only en el path de escritura — falla silenciosa al
 * supabase para no bloquear el flujo principal del LLM.
 */
@Injectable()
export class LLMUsageLogger {
  private readonly logger = new Logger(LLMUsageLogger.name);
  private readonly als = new AsyncLocalStorage<LLMUsageContext>();

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Corre `fn` con un contexto activo. Cualquier `record(...)` llamado
   * sincrónicamente desde dentro de `fn` (incluso transitivamente)
   * lee este contexto. Sin contexto, `record` igual persiste con
   * `operation='unknown'` (last-resort para no perder datos).
   */
  withContext<T>(ctx: LLMUsageContext, fn: () => Promise<T>): Promise<T> {
    return this.als.run(ctx, fn);
  }

  /**
   * Persiste la call. Fire-and-forget — no awaitamos al caller del
   * LLM service para no agregar latencia. Errores van al log.
   */
  record(input: RecordCallInput): void {
    const ctx = this.als.getStore();
    void this.persist(ctx, input).catch((err) => {
      this.logger.warn(
        `Failed to log LLM usage: ${(err as Error).message}`,
      );
    });
  }

  private async persist(
    ctx: LLMUsageContext | undefined,
    input: RecordCallInput,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('llm_usage_log')
      .insert({
        company_id: ctx?.companyId ?? null,
        operation: ctx?.operation ?? 'unknown',
        model: input.model,
        prompt_tokens: input.promptTokens,
        completion_tokens: input.completionTokens,
        total_tokens: input.totalTokens,
        duration_ms: input.durationMs ?? null,
        job_id: ctx?.jobId ?? null,
      });
    if (error) throw new Error(error.message);
  }

  /**
   * GET handler — agrega últimos N días por operation y por modelo.
   * Usado por el dashboard widget. Si `companyId` es undefined,
   * filtra null + matches (modo "tenant del caller solamente"); si
   * el caller quiere TODAS las companies, se usa otra ruta.
   */
  async summary(days: number, companyId?: string): Promise<UsageSummary> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString();

    let query = this.supabase
      .from('llm_usage_log')
      .select('operation, model, prompt_tokens, completion_tokens, total_tokens')
      .gte('created_at', since);
    if (companyId) {
      query = query.eq('company_id', companyId);
    }
    const { data, error } = await query;
    if (error) {
      this.logger.error(`summary query failed: ${error.message}`);
      return this.empty();
    }

    const rows = data ?? [];
    const totals = {
      calls: rows.length,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const byOpMap = new Map<
      string,
      { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }
    >();
    const byModelMap = new Map<
      string,
      { calls: number; totalTokens: number }
    >();

    for (const r of rows) {
      const pt = r.prompt_tokens as number;
      const ct = r.completion_tokens as number;
      const tt = r.total_tokens as number;
      totals.promptTokens += pt;
      totals.completionTokens += ct;
      totals.totalTokens += tt;

      const op = r.operation as string;
      const opAcc = byOpMap.get(op) ?? {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      opAcc.calls += 1;
      opAcc.promptTokens += pt;
      opAcc.completionTokens += ct;
      opAcc.totalTokens += tt;
      byOpMap.set(op, opAcc);

      const model = r.model as string;
      const mAcc = byModelMap.get(model) ?? { calls: 0, totalTokens: 0 };
      mAcc.calls += 1;
      mAcc.totalTokens += tt;
      byModelMap.set(model, mAcc);
    }

    return {
      totals,
      byOperation: Array.from(byOpMap.entries())
        .map(([operation, acc]) => ({ operation, ...acc }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      byModel: Array.from(byModelMap.entries())
        .map(([model, acc]) => ({ model, ...acc }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }

  /**
   * Daily aggregation — buckets por fecha (YYYY-MM-DD) con totales.
   * Útil para sparklines del dashboard. Rellena con 0 los días sin
   * actividad para que el gráfico tenga la longitud correcta.
   */
  async daily(
    days: number,
    companyId?: string,
  ): Promise<
    Array<{
      date: string;
      calls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }>
  > {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);

    let query = this.supabase
      .from('llm_usage_log')
      .select('created_at, prompt_tokens, completion_tokens, total_tokens')
      .gte('created_at', since.toISOString());
    if (companyId) {
      query = query.eq('company_id', companyId);
    }
    const { data, error } = await query;
    if (error) {
      this.logger.error(`daily query failed: ${error.message}`);
      return [];
    }

    // Bucket por día (UTC). Llave = YYYY-MM-DD.
    const buckets = new Map<
      string,
      { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }
    >();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    }

    for (const r of data ?? []) {
      const day = new Date(r.created_at as string).toISOString().slice(0, 10);
      const b = buckets.get(day);
      if (!b) continue; // fuera de la ventana (raro)
      b.calls += 1;
      b.promptTokens += r.prompt_tokens as number;
      b.completionTokens += r.completion_tokens as number;
      b.totalTokens += r.total_tokens as number;
    }

    return Array.from(buckets.entries())
      .map(([date, acc]) => ({ date, ...acc }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private empty(): UsageSummary {
    return {
      totals: {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      byOperation: [],
      byModel: [],
    };
  }
}
