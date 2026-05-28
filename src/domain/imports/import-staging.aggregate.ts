import type {
  ImportPayload,
  ImportSource,
  ImportStagingStatus,
} from './import-payload.types';

/**
 * ImportStaging — aggregate del row de `imports_staging`. Inmutable
 * desde el dominio; las transiciones de status (`pending_review` →
 * `confirming` → `committed`) las hace el committer.
 */

export interface ImportStagingProps {
  id: string;
  companyId: string;
  createdBy: string | null;
  source: ImportSource;
  payload: ImportPayload;
  status: ImportStagingStatus;
  previewCache: unknown | null;
  commitReport: unknown | null;
  createdAt: Date;
  expiresAt: Date;
  committedAt: Date | null;
  /** Fase 3: archivo original en bucket privado, solo para source='upload_freeform'. */
  uploadStoragePath: string | null;
  uploadMimeType: string | null;
  /** Raw output del vision LLM (solo accesible vía /admin/imports/:id/raw). */
  extractRawOutput: unknown | null;
}

export class ImportStaging {
  private constructor(private readonly props: ImportStagingProps) {}

  static fromPersistence(props: ImportStagingProps): ImportStaging {
    return new ImportStaging(props);
  }

  /** Crear staging fresco al recibir un payload de cualquiera de las 3 vías. */
  static create(input: {
    id: string;
    companyId: string;
    createdBy: string | null;
    source: ImportSource;
    payload: ImportPayload;
    ttlDays?: number;
  }): ImportStaging {
    const now = new Date();
    const ttlDays = input.ttlDays ?? 5;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 3600 * 1000);
    return new ImportStaging({
      id: input.id,
      companyId: input.companyId,
      createdBy: input.createdBy,
      source: input.source,
      payload: input.payload,
      status: 'pending_review',
      previewCache: null,
      commitReport: null,
      createdAt: now,
      expiresAt,
      committedAt: null,
      uploadStoragePath: null,
      uploadMimeType: null,
      extractRawOutput: null,
    });
  }

  /**
   * Fase 3: crear staging en status='extracting' al recibir un upload
   * libre. El payload arranca vacío (placeholder) — el worker lo
   * reemplaza vía `withExtractedPayload` cuando la vision termina.
   */
  static createForExtraction(input: {
    id: string;
    companyId: string;
    createdBy: string | null;
    storagePath: string;
    mimeType: string;
    ttlDays?: number;
  }): ImportStaging {
    const now = new Date();
    const ttlDays = input.ttlDays ?? 5;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 3600 * 1000);
    const placeholderPayload: ImportPayload = {
      schemaVersion: '1.0.0',
      source: 'upload_freeform',
      sourceMetadata: { extractedAt: now.toISOString() },
      data: {},
    };
    return new ImportStaging({
      id: input.id,
      companyId: input.companyId,
      createdBy: input.createdBy,
      source: 'upload_freeform',
      payload: placeholderPayload,
      status: 'extracting',
      previewCache: null,
      commitReport: null,
      createdAt: now,
      expiresAt,
      committedAt: null,
      uploadStoragePath: input.storagePath,
      uploadMimeType: input.mimeType,
      extractRawOutput: null,
    });
  }

  // ── Getters ────────────────────────────────────────────────────────
  get id(): string {
    return this.props.id;
  }
  get companyId(): string {
    return this.props.companyId;
  }
  get createdBy(): string | null {
    return this.props.createdBy;
  }
  get source(): ImportSource {
    return this.props.source;
  }
  get payload(): ImportPayload {
    return this.props.payload;
  }
  get status(): ImportStagingStatus {
    return this.props.status;
  }
  get previewCache(): unknown | null {
    return this.props.previewCache;
  }
  get commitReport(): unknown | null {
    return this.props.commitReport;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get committedAt(): Date | null {
    return this.props.committedAt;
  }
  get uploadStoragePath(): string | null {
    return this.props.uploadStoragePath;
  }
  get uploadMimeType(): string | null {
    return this.props.uploadMimeType;
  }
  get extractRawOutput(): unknown | null {
    return this.props.extractRawOutput;
  }

  isExpired(now: Date = new Date()): boolean {
    return this.props.expiresAt.getTime() < now.getTime();
  }

  // ── Transitions ────────────────────────────────────────────────────
  withPreviewCache(preview: unknown): ImportStaging {
    return new ImportStaging({ ...this.props, previewCache: preview });
  }

  /**
   * Fase 3: instala el payload extraído por vision + raw output, y
   * mueve a 'pending_review' para que el owner lo revise como
   * cualquier otro staging.
   */
  withExtractedPayload(
    payload: ImportPayload,
    extractRawOutput: unknown,
  ): ImportStaging {
    if (this.props.status !== 'extracting') {
      throw new Error(
        `Cannot install extracted payload from status ${this.props.status} (id=${this.props.id})`,
      );
    }
    return new ImportStaging({
      ...this.props,
      payload,
      status: 'pending_review',
      extractRawOutput,
    });
  }

  /**
   * Fase 3: el vision LLM falló (network, parse, etc.). Marcamos
   * failed con el error en commit_report para que el frontend lo
   * muestre. `extractRawOutput` opcional — útil si hubo respuesta del
   * modelo pero no parseable.
   */
  markExtractFailed(
    error: { message: string; cause?: string },
    extractRawOutput?: unknown,
  ): ImportStaging {
    return new ImportStaging({
      ...this.props,
      status: 'failed',
      commitReport: {
        phase: 'extract',
        error: error.message,
        cause: error.cause ?? null,
        at: new Date().toISOString(),
      },
      extractRawOutput: extractRawOutput ?? this.props.extractRawOutput,
    });
  }

  markConfirming(): ImportStaging {
    if (this.props.status !== 'pending_review') {
      throw new Error(
        `Cannot confirm import in status ${this.props.status} (id=${this.props.id})`,
      );
    }
    return new ImportStaging({ ...this.props, status: 'confirming' });
  }

  markCommitted(commitReport: unknown): ImportStaging {
    return new ImportStaging({
      ...this.props,
      status: 'committed',
      commitReport,
      committedAt: new Date(),
    });
  }

  markFailed(commitReport: unknown): ImportStaging {
    return new ImportStaging({
      ...this.props,
      status: 'failed',
      commitReport,
    });
  }

  markDiscarded(): ImportStaging {
    return new ImportStaging({ ...this.props, status: 'discarded' });
  }
}
