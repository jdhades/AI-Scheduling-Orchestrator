import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { ILLMService } from '../../domain/services/llm.service.interface';
import { withExponentialBackoff } from '../utils/with-exponential-backoff';
import { LLMUsageTracker } from '../observability/llm-usage-tracker.service';
import {
  IntegrationCredentialsService,
  INTEGRATION_UPDATED_EVENT,
  type IntegrationUpdatedPayload,
} from '../integrations/integration-credentials.service';

/**
 * LocalLLMService — implementación de ILLMService contra un runtime local
 * con API OpenAI-compatible (LM Studio, Ollama, llama.cpp server, etc.).
 *
 * Config via env:
 *   LLM_LOCAL_BASE_URL — endpoint completo de chat completions
 *                       (default: http://127.0.0.1:1234/v1/chat/completions)
 *   LLM_LOCAL_MODEL    — model id que el runtime expone en /v1/models
 *
 * No requiere API key (el server local acepta la request sin Authorization).
 */
@Injectable()
export class LocalLLMService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(LocalLLMService.name);
  private baseUrl = '';
  private model = '';
  private readonly TIMEOUT_MS = 300_000;

  constructor(
    private readonly config: ConfigService,
    private readonly usageTracker: LLMUsageTracker,
    private readonly integrations: IntegrationCredentialsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const cfg = await this.integrations.get('local_llm');
    if (cfg && cfg.enabled) {
      const c = cfg.credentials as { baseUrl?: string; model?: string };
      if (c.baseUrl) {
        this.baseUrl = c.baseUrl;
        this.model = c.model ?? 'local-model';
        this.logger.log(
          `LocalLLMService enabled from integration_credentials → ${this.baseUrl} (model=${this.model})`,
        );
        return;
      }
    }
    this.baseUrl =
      this.config.get<string>('llmLocal.baseUrl') ??
      'http://127.0.0.1:1234/v1/chat/completions';
    this.model = this.config.get<string>('llmLocal.model') ?? 'local-model';
    this.logger.log(
      `LocalLLMService configured from .env → ${this.baseUrl} (model=${this.model})`,
    );
  }

  @OnEvent(INTEGRATION_UPDATED_EVENT)
  async onIntegrationUpdated(payload: IntegrationUpdatedPayload): Promise<void> {
    if (payload.provider !== 'local_llm') return;
    if (payload.environment !== this.integrations.activeEnv) return;
    this.logger.log('LocalLLMService: integration updated — reloading.');
    await this.reload();
  }

  async testConnection(creds: {
    baseUrl: string;
    model?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(creds.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: creds.model ?? 'local-model',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async complete(prompt: string, _signal?: AbortSignal): Promise<string> {
    return withExponentialBackoff(
      () => this.callLocal(prompt),
      'LocalLLMService',
      { maxRetries: 1, initialDelayMs: 1000 },
    );
  }

  private async callLocal(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 4096,
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `LocalLLMService: HTTP ${response.status} — ${response.statusText} — ${body}`,
      );
    }

    const json = await response.json();
    const rawText: string = json?.choices?.[0]?.message?.content ?? '';

    const usage = json?.usage;
    if (usage) {
      this.logger.log(
        `📊 Local LLM Token Usage -> Prompt: ${usage.prompt_tokens} | Completion: ${usage.completion_tokens} | Total: ${usage.total_tokens}`,
      );
      this.usageTracker.record({
        prompt: usage.prompt_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        total: usage.total_tokens ?? 0,
      });
    }

    if (!rawText) {
      throw new Error('LocalLLMService: empty response from local runtime');
    }

    this.logger.debug(
      `LocalLLMService: received ${rawText.length} chars from ${this.model}`,
    );
    return rawText;
  }
}
