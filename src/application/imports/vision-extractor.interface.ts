import type { ImportPayload } from '../../domain/imports/import-payload.types';

/**
 * Resultado de una extracción vision → ImportPayload.
 *
 * El raw output (texto del modelo + usage) se persiste en
 * `imports_staging.extract_raw_output` para que el admin pueda
 * inspeccionarlo si el parse falla o si el payload no representa el
 * archivo subido.
 */
export interface VisionExtractResult {
  payload: ImportPayload;
  raw: {
    model: string;
    provider: 'anthropic' | 'gemini' | 'qwen';
    rawText: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface VisionExtractInput {
  /** PDF/PNG/JPG/WEBP — el provider decide cómo lo manda al modelo. */
  buffer: Buffer;
  mimeType: string;
  /** Nombre original — útil para el modelo como hint contextual. */
  originalName: string;
  /** Modelo configurado por el tenant. Si null, el service usa su default. */
  modelOverride: string | null;
  /** Tenant context para usage logging. */
  companyId: string;
  /**
   * Locale del owner para escribir `warnings[].message` en su idioma.
   * 'es' | 'en' — defaults a 'en' si el caller no lo pasa.
   */
  locale: 'es' | 'en';
}

/**
 * IVisionExtractor — extrae un ImportPayload desde un archivo
 * (PDF/imagen) usando un LLM con visión.
 *
 * Cada provider (anthropic, gemini, qwen) implementa esta interface.
 * El VisionResolverService elige el provider según
 * `companies.imports_vision_provider`.
 *
 * Errores:
 *   - VisionExtractError si el modelo devuelve algo no-parseable.
 *   - Network / 5xx del provider re-lanzan tal cual para que el worker
 *     los capture y emita WS LlmJobFailed.
 */
export interface IVisionExtractor {
  /** Identificador human-readable del provider — para logs y raw output. */
  readonly providerName: 'anthropic' | 'gemini' | 'qwen';

  /** Modelo default si el tenant no override-ea. */
  readonly defaultModel: string;

  extract(input: VisionExtractInput): Promise<VisionExtractResult>;
}

export class VisionExtractError extends Error {
  constructor(
    message: string,
    public readonly cause: 'no_json' | 'invalid_json' | 'schema_mismatch',
    public readonly rawText?: string,
  ) {
    super(message);
    this.name = 'VisionExtractError';
  }
}

export const VISION_EXTRACTOR_TOKEN = Symbol('IVisionExtractor');
