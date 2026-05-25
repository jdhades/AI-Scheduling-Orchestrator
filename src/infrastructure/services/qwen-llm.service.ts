import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ILLMService } from '../../domain/services/llm.service.interface';
import { withExponentialBackoff } from '../utils/with-exponential-backoff';
import { LLMUsageTracker } from '../observability/llm-usage-tracker.service';
import { LLMUsageLogger } from '../observability/llm-usage-logger.service';

/**
 * QwenLLMService — Implementación concreta de ILLMService
 *
 * Usa Qwen Plus (vía Alibaba Cloud DashScope OpenAI-compatible API)
 * para completar prompts de automatización y scheduling cognitivo.
 */
@Injectable()
export class QwenLLMService implements ILLMService {
  private readonly logger = new Logger(QwenLLMService.name);
  private readonly apiKey: string | undefined;
  private readonly model = 'qwen3.6-plus';
  private readonly baseUrl =
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
  private readonly TIMEOUT_MS = 300_000;

  constructor(
    private readonly config: ConfigService,
    private readonly usageTracker: LLMUsageTracker,
    private readonly usageLogger: LLMUsageLogger,
  ) {
    this.apiKey = this.config.get<string>('qwen.apiKey');
    if (!this.apiKey) {
      this.logger.warn(
        'QwenLLMService: QWEN_API_KEY not configured — LLM calls will fail gracefully',
      );
    }
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    if (!this.apiKey) {
      throw new Error('QwenLLMService: QWEN_API_KEY is not configured');
    }

    return withExponentialBackoff(
      () => this.callQwen(prompt, signal),
      'QwenLLMService',
      { maxRetries: 3, initialDelayMs: 2000 },
    );
  }

  private async callQwen(
    prompt: string,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    // Si el caller pasó un signal externo (ej. cancel de un job), lo
    // combinamos con el timeout interno: cualquiera de los dos aborta.
    const timeoutSignal = AbortSignal.timeout(this.TIMEOUT_MS);
    const fetchSignal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: fetchSignal,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1, // Bajo para respuestas deterministas estructuradas
          max_tokens: 8192, // qwen3.x "thinking mode" consume completion tokens internamente;
          //                  el caller usa `extractJson` para tolerar prosa + JSON
          // NOTA: no se usa `response_format: json_object` porque los prompts
          // actuales piden chain-of-thought (razonamiento + JSON al final).
          // Forzar json_object contradice esa instrucción y hace que el modelo
          // consuma el techo de tokens intentando cuadrar ambas. El caller
          // extrae el bloque JSON del output mixto.
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Distinguir cancel del usuario vs timeout interno re-lanzando
        // un mensaje específico que el worker puede classificar.
        const wasCancelled =
          externalSignal?.aborted === true && timeoutSignal.aborted === false;
        throw new Error(
          wasCancelled
            ? 'QwenLLMService: request cancelled by caller'
            : `QwenLLMService: timeout after ${this.TIMEOUT_MS}ms`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `QwenLLMService: HTTP ${response.status} — ${response.statusText} — ${body}`,
      );
    }

    const json = await response.json();
    const rawText: string = json?.choices?.[0]?.message?.content ?? '';

    const usage = json?.usage;
    if (usage) {
      this.logger.log(
        `📊 Qwen LLM Token Usage -> Prompt: ${usage.prompt_tokens} | Completion: ${usage.completion_tokens} | Total: ${usage.total_tokens}`,
      );
      this.usageTracker.record({
        prompt: usage.prompt_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        total: usage.total_tokens ?? 0,
      });
      // Persistencia para el dashboard de costos (lee contexto via ALS).
      this.usageLogger.record({
        model: this.model,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        durationMs: Date.now() - startedAt,
      });
    }

    if (!rawText) {
      throw new Error('QwenLLMService: empty response from Qwen');
    }

    this.logger.debug(
      `QwenLLMService: received ${rawText.length} chars from Qwen`,
    );
    return rawText;
  }
}
