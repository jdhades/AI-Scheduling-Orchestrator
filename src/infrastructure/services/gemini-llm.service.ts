import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ILLMService } from '../../domain/services/llm.service.interface';

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
export class GeminiLLMService implements ILLMService {
  private readonly logger = new Logger(GeminiLLMService.name);
  private readonly apiKey: string | undefined;
  private readonly model = 'gemini-1.5-flash'; // Flash: menor latencia para scheduling
  private readonly TIMEOUT_MS = 15_000;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!this.apiKey) {
      this.logger.warn(
        'GeminiLLMService: GEMINI_API_KEY not configured — LLM calls will fail gracefully',
      );
    }
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GeminiLLMService: GEMINI_API_KEY is not configured');
    }

    return this.callWithRetry(prompt, 1);
  }

  private async callWithRetry(
    prompt: string,
    retriesLeft: number,
  ): Promise<string> {
    try {
      return await this.callGemini(prompt);
    } catch (error) {
      const isNetworkError = !(
        error instanceof Error && error.message.includes('HTTP')
      );
      if (retriesLeft > 0 && isNetworkError) {
        this.logger.warn(
          `GeminiLLMService: retrying after error: ${(error as Error).message}`,
        );
        await this.sleep(1000);
        return this.callWithRetry(prompt, retriesLeft - 1);
      }
      throw error;
    }
  }

  private async callGemini(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

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
            maxOutputTokens: 2048,
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
