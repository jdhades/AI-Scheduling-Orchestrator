import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type {
  ILLMService,
  LLMCompleteOptions,
} from '../../domain/services/llm.service.interface';
import { withExponentialBackoff } from '../utils/with-exponential-backoff';
import {
  IntegrationCredentialsService,
  INTEGRATION_UPDATED_EVENT,
  type IntegrationUpdatedPayload,
} from '../integrations/integration-credentials.service';

/**
 * GeminiLLMService — Implementación concreta de ILLMService
 *
 * Usa Gemini 1.5 Pro (API REST) para completar prompts de scheduling.
 * Reutiliza el mismo GEMINI_API_KEY del GeminiEmbeddingService.
 *
 * Características:
 * - Timeout de 15 segundos (los LLMs son lentos en prompts largos)
 * - Retry x1 automático ante fallo de red (no ante errores 4xx)
 * - Extracción robusta: la respuesta puede venir con wrapping de markdown
 */
@Injectable()
export class GeminiLLMService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(GeminiLLMService.name);
  private apiKey: string | undefined;
  /** Default cuando el caller no especifica `options.model`. */
  private readonly defaultModel = 'gemini-2.0-flash';
  private readonly TIMEOUT_MS = 15_000;

  constructor(
    private readonly config: ConfigService,
    private readonly integrations: IntegrationCredentialsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const cfg = await this.integrations.get('gemini');
    if (cfg && cfg.enabled) {
      const k = (cfg.credentials as { apiKey?: string }).apiKey;
      if (k) {
        this.apiKey = k;
        this.logger.log(
          `GeminiLLMService enabled from integration_credentials (env=${this.integrations.activeEnv}).`,
        );
        return;
      }
    }
    this.apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (this.apiKey) {
      this.logger.log('GeminiLLMService enabled from .env (legacy fallback).');
    } else {
      this.logger.warn(
        'GeminiLLMService: GEMINI_API_KEY not configured — LLM calls will fail gracefully',
      );
    }
  }

  @OnEvent(INTEGRATION_UPDATED_EVENT)
  async onIntegrationUpdated(
    payload: IntegrationUpdatedPayload,
  ): Promise<void> {
    if (payload.provider !== 'gemini') return;
    if (payload.environment !== this.integrations.activeEnv) return;
    this.logger.log('GeminiLLMService: integration updated — reloading.');
    await this.reload();
  }

  async testConnection(creds: {
    apiKey: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.defaultModel}:generateContent?key=${creds.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          error: `HTTP ${res.status}: ${body.slice(0, 120)}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async complete(prompt: string, options?: LLMCompleteOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GeminiLLMService: GEMINI_API_KEY is not configured');
    }
    const model = options?.model ?? this.defaultModel;

    return withExponentialBackoff(
      () => this.callGemini(prompt, model),
      'GeminiLLMService',
      { maxRetries: 3, initialDelayMs: 2000 },
    );
  }

  private async callGemini(prompt: string, model: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1, // Bajo: necesitamos respuestas deterministas
            topK: 20,
            topP: 0.8,
            maxOutputTokens: 4096, // ~30 asignaciones × 50 tokens/objeto + overhead JSON
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                blocks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      employeeId: { type: 'string' },
                      shiftId: { type: 'string' },
                    },
                    required: ['employeeId', 'shiftId'],
                  },
                },
                multi_shift_permits: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      employeeId: { type: 'string' },
                      day: { type: 'string' },
                    },
                    required: ['employeeId', 'day'],
                  },
                },
                assignments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      shiftId: { type: 'string' },
                      employeeId: { type: 'string' },
                      reason: { type: 'string' },
                      confidence: { type: 'number' },
                    },
                    required: ['shiftId', 'employeeId'],
                  },
                },
              },
              required: ['assignments'],
            },
          },
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(
        `GeminiLLMService: HTTP ${response.status} — ${response.statusText}`,
      );
    }

    const json = await response.json();
    const rawText: string =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    if (!rawText) {
      throw new Error('GeminiLLMService: empty response from Gemini');
    }

    this.logger.debug(
      `GeminiLLMService: received ${rawText.length} chars from Gemini`,
    );
    return rawText;
  }
}
