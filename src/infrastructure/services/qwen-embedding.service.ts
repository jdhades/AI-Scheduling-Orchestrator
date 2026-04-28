import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IEmbeddingService } from '../../domain/services/embedding.service.interface';
import { withExponentialBackoff } from '../utils/with-exponential-backoff';

/**
 * QwenEmbeddingService — Infrastructure Service
 *
 * Concrete implementation of IEmbeddingService using Alibaba Cloud DashScope (Qwen).
 * Model: text-embedding-v3
 * Dimensionality: 768 (strictly set to match pgvector ivfflat configuration)
 */
@Injectable()
export class QwenEmbeddingService implements IEmbeddingService {
  private readonly logger = new Logger(QwenEmbeddingService.name);
  private readonly model = 'text-embedding-v3';
  private readonly apiKey: string;
  // OpenAI compatible mode base URL targeting International
  private readonly baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('qwen.apiKey', '');
  }

  /**
   * Generates a 768-D vector for the given text.
   * @throws Error if text is empty or API fails
   */
  async generate(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('EmbeddingService: text cannot be empty');
    }

    return withExponentialBackoff(
      async () => {
        let response: Response;
        try {
          response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.model,
              input: text.substring(0, 2048),
              dimensions: 768,
            }),
          });
        } catch (networkError) {
          this.logger.error(`QwenEmbeddingService: network error`, networkError);
          throw new Error(
            `EmbeddingService: network error — ${(networkError as Error).message}`,
          );
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '(no body)');
          this.logger.error(
            `QwenEmbeddingService: API returned ${response.status} — ${body}`,
          );
          throw new Error(
            `EmbeddingService: API error ${response.status} — ${response.statusText}`,
          );
        }

        const json = (await response.json()) as any;
        const values: number[] = json?.data?.[0]?.embedding;

        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(
            'EmbeddingService: API returned empty or invalid embedding',
          );
        }

        return values;
      },
      'QwenEmbeddingService',
      { maxRetries: 3, initialDelayMs: 2000 }
    );
  }

  /**
   * Generates embeddings in batch to handle large sets of generic entries.
   */
  async generateBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Limit parallelism to respect Free/Tier1 rate limits
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
