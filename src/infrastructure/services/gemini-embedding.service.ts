import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IEmbeddingService } from '../../domain/services/embedding.service.interface';
import { withExponentialBackoff } from '../utils/with-exponential-backoff';

/**
 * GeminiEmbeddingService — Infrastructure Service
 *
 * Implementación concreta de IEmbeddingService usando la API de Google Gemini.
 * Modelo: text-embedding-004 (768 dimensiones, multilingüe, optimizado para búsqueda semántica)
 *
 * Por qué text-embedding-004:
 *   - 768 dims (balance perfecto para pgvector ivfflat)
 *   - Soporte nativo para español e inglés — ideal para reglas de empresa
 *   - Mismo ecosistema que Gemini 1.5 Pro (ya usado en el proyecto)
 *   - Costo menor que modelos de embeddings de OpenAI
 */
@Injectable()
export class GeminiEmbeddingService implements IEmbeddingService {
  private readonly logger = new Logger(GeminiEmbeddingService.name);
  private readonly model = 'gemini-embedding-001';
  private readonly apiKey: string;
  private readonly baseUrl =
    'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('gemini.apiKey', '');
  }

  /**
   * Genera un vector de 768 dimensiones para el texto dado.
   * @throws Error si el texto está vacío o la API falla
   */
  async generate(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('EmbeddingService: text cannot be empty');
    }

    const url = `${this.baseUrl}/${this.model}:embedContent?key=${this.apiKey}`;

    return withExponentialBackoff(
      async () => {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: `models/${this.model}`,
              content: {
                parts: [{ text: text.substring(0, 2048) }], // límite de la API
              },
            }),
          });
        } catch (networkError) {
          this.logger.error(`GeminiEmbeddingService: network error`, networkError);
          throw new Error(
            `EmbeddingService: network error — ${(networkError as Error).message}`,
          );
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '(no body)');
          this.logger.error(
            `GeminiEmbeddingService: API returned ${response.status} — ${body}`,
          );
          throw new Error(
            `EmbeddingService: API error ${response.status} — ${response.statusText}`,
          );
        }

        const json = await response.json();
        const values: number[] = json?.embedding?.values;

        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(
            'EmbeddingService: API returned empty or invalid embedding',
          );
        }

        return values;
      },
      'GeminiEmbeddingService',
      { maxRetries: 3, initialDelayMs: 2000 }
    );
  }

  /**
   * Genera embeddings para múltiples textos en paralelo.
   * Útil para inicializar reglas existentes sin embedding.
   */
  async generateBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Limitar paralelismo a 5 requests simultáneos para respetar rate limits de capa gratuita
    const BATCH_SIZE = 5;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((t) => this.generate(t)),
      );
      results.push(...batchResults);
    }

    return results;
  }
}
