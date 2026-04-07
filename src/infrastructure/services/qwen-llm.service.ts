import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ILLMService } from '../../domain/services/llm.service.interface';
import { withExponentialBackoff } from '../utils/with-exponential-backoff';

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
  private readonly model = 'qwen-plus'; // O 'qwen-max' o 'qwen-turbo'
  private readonly baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
  private readonly TIMEOUT_MS = 25_000;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('qwen.apiKey');
    if (!this.apiKey) {
      this.logger.warn(
        'QwenLLMService: QWEN_API_KEY not configured — LLM calls will fail gracefully',
      );
    }
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('QwenLLMService: QWEN_API_KEY is not configured');
    }

    return withExponentialBackoff(
      () => this.callQwen(prompt),
      'QwenLLMService',
      { maxRetries: 3, initialDelayMs: 2000 }
    );
  }

  private async callQwen(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1, // Bajo para respuestas deterministas estructuradas
          max_tokens: 2048,
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `QwenLLMService: HTTP ${response.status} — ${response.statusText} — ${body}`,
      );
    }

    const json = (await response.json()) as any;
    const rawText: string = json?.choices?.[0]?.message?.content ?? '';

    if (!rawText) {
      throw new Error('QwenLLMService: empty response from Qwen');
    }

    this.logger.debug(
      `QwenLLMService: received ${rawText.length} chars from Qwen`,
    );
    return rawText;
  }
}
