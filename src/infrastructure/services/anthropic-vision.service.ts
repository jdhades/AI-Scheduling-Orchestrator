import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import Anthropic from '@anthropic-ai/sdk';
import type {
  IVisionExtractor,
  VisionExtractInput,
  VisionExtractResult,
} from '../../application/imports/vision-extractor.interface';
import { VisionExtractError } from '../../application/imports/vision-extractor.interface';
import {
  VISION_EXTRACT_SYSTEM_PROMPT,
  VISION_EXTRACT_USER_PROMPT,
  extractJsonFromOutput,
} from '../../application/imports/vision-extract-prompt';
import type { ImportPayload } from '../../domain/imports/import-payload.types';
import { IMPORT_SCHEMA_VERSION } from '../../domain/imports/import-payload.types';
import {
  IntegrationCredentialsService,
  INTEGRATION_UPDATED_EVENT,
  type IntegrationUpdatedPayload,
} from '../integrations/integration-credentials.service';

/**
 * AnthropicVisionService — extrae `ImportPayload` desde PDF/imagen con
 * Claude (vision nativa).
 *
 * Separado de OCRService (mockup) y de los providers texto-only (Qwen).
 * La API key vive en `integration_credentials` (provider='anthropic')
 * y se recarga vía evento `integration.updated` cuando el admin la
 * cambia desde /admin/integrations.
 *
 * Modelo default: `claude-sonnet-4-6` — balance costo/calidad para
 * extracción estructurada. Tenant puede override-ar vía
 * `companies.imports_vision_model`.
 */
@Injectable()
export class AnthropicVisionService implements IVisionExtractor, OnModuleInit {
  private readonly logger = new Logger(AnthropicVisionService.name);
  private client: Anthropic | null = null;
  readonly providerName = 'anthropic' as const;
  readonly defaultModel = 'claude-sonnet-4-6';
  /**
   * Sonnet 4.6 soporta hasta 64K output tokens. 8192 era demasiado
   * chico — extracciones con 20+ empleados ya se cortaban a la mitad.
   * 32K cubre archivos típicos (100+ filas) sin pagar margen excesivo
   * porque Anthropic factura por tokens *generados*, no por el techo.
   */
  private readonly maxTokens = 32768;

  constructor(
    private readonly config: ConfigService,
    private readonly integrations: IntegrationCredentialsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  @OnEvent(INTEGRATION_UPDATED_EVENT)
  async onIntegrationUpdated(
    payload: IntegrationUpdatedPayload,
  ): Promise<void> {
    if (payload.provider !== 'anthropic') return;
    if (payload.environment !== this.integrations.activeEnv) return;
    this.logger.log('AnthropicVisionService: integration updated — reloading.');
    await this.reload();
  }

  private async reload(): Promise<void> {
    const cfg = await this.integrations.get('anthropic');
    let apiKey: string | undefined;
    if (cfg && cfg.enabled) {
      apiKey = (cfg.credentials as { apiKey?: string }).apiKey;
    }
    if (!apiKey) {
      apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    }
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log(
        `AnthropicVisionService enabled (env=${this.integrations.activeEnv}).`,
      );
    } else {
      this.client = null;
      this.logger.warn(
        'AnthropicVisionService: no API key — vision extraction will fail gracefully.',
      );
    }
  }

  async testConnection(creds: {
    apiKey: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = new Anthropic({ apiKey: creds.apiKey });
      // Llamada barata: 1 token de output.
      await client.messages.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async extract(input: VisionExtractInput): Promise<VisionExtractResult> {
    if (!this.client) {
      throw new Error(
        'AnthropicVisionService: API key not configured. Set it in /admin/integrations.',
      );
    }

    const model = input.modelOverride ?? this.defaultModel;
    const content = this.buildContentBlocks(input);

    const response = await this.client.messages.create({
      model,
      max_tokens: this.maxTokens,
      system: VISION_EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });

    const rawText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // Diagnóstico crudo: shape completo de los content blocks + stop_reason.
    // Si Claude devolvió tool_use/thinking/refusal en lugar de text, este
    // dump nos lo dice. Lo guardamos en el error para que /admin/imports/:id/raw
    // lo pueda inspeccionar.
    const diagnostic = {
      stopReason: response.stop_reason,
      blockTypes: response.content.map((b) => b.type),
      blocks: response.content,
    };

    if (!rawText) {
      throw new VisionExtractError(
        `Vision LLM returned no text content (stop_reason=${response.stop_reason ?? 'unknown'}, blocks=[${diagnostic.blockTypes.join(',')}]).`,
        'no_json',
        JSON.stringify(diagnostic),
      );
    }

    const parsed = extractJsonFromOutput(rawText);
    if (parsed === null) {
      // Si stop_reason='max_tokens' el JSON quedó cortado a la mitad
      // y nunca cierra. Damos un mensaje específico para que el owner
      // sepa que hay que dividir el archivo, no es bug del prompt.
      if (response.stop_reason === 'max_tokens') {
        throw new VisionExtractError(
          `Vision LLM output was truncated at ${response.usage.output_tokens} tokens (max=${this.maxTokens}). The file has more data than fits in one response — try splitting it into smaller files.`,
          'no_json',
          rawText,
        );
      }
      throw new VisionExtractError(
        'Vision LLM returned non-parseable output. See raw output for debugging.',
        'no_json',
        rawText,
      );
    }
    const payload = this.normalizePayload(parsed, model);

    return {
      payload,
      raw: {
        model,
        provider: 'anthropic',
        rawText,
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  /**
   * Construye los content blocks: el documento (PDF como `document`,
   * imagen como `image`) + el prompt textual del user. Claude soporta
   * `application/pdf` nativo desde 4.x.
   */
  private buildContentBlocks(
    input: VisionExtractInput,
  ): Anthropic.MessageParam['content'] {
    const base64 = input.buffer.toString('base64');
    const mediaType = input.mimeType;

    if (mediaType === 'application/pdf') {
      return [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
        },
        { type: 'text', text: VISION_EXTRACT_USER_PROMPT },
      ];
    }

    if (
      mediaType === 'image/png' ||
      mediaType === 'image/jpeg' ||
      mediaType === 'image/jpg' ||
      mediaType === 'image/webp'
    ) {
      return [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType === 'image/jpg' ? 'image/jpeg' : mediaType,
            data: base64,
          },
        },
        { type: 'text', text: VISION_EXTRACT_USER_PROMPT },
      ];
    }

    throw new Error(
      `AnthropicVisionService: unsupported mime type "${mediaType}". Allowed: application/pdf, image/png, image/jpeg, image/webp.`,
    );
  }

  /**
   * Asegura los campos mínimos del schema canónico. El modelo a veces
   * omite `schemaVersion` o `source` aunque el prompt los pida — los
   * forzamos acá para no romper el DTO downstream.
   */
  private normalizePayload(parsed: unknown, model: string): ImportPayload {
    if (!parsed || typeof parsed !== 'object') {
      throw new VisionExtractError(
        'Vision LLM returned non-object payload.',
        'schema_mismatch',
      );
    }
    const p = parsed as Record<string, unknown>;
    const data = (p.data as Record<string, unknown>) ?? {};
    const sourceMetadata = (p.sourceMetadata as Record<string, unknown>) ?? {};

    return {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      source: 'upload_freeform',
      sourceMetadata: {
        extractedAt:
          (sourceMetadata.extractedAt as string) ?? new Date().toISOString(),
        agentName: `anthropic:${model}`,
        agentVersion: (sourceMetadata.agentVersion as string) ?? undefined,
        confidence: (sourceMetadata.confidence as number) ?? undefined,
        notes: (sourceMetadata.notes as string) ?? undefined,
      },
      data: data,
      warnings: (p.warnings as ImportPayload['warnings']) ?? [],
      unresolvedReferences:
        (p.unresolvedReferences as ImportPayload['unresolvedReferences']) ?? [],
    };
  }
}
