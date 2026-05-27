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

  isExpired(now: Date = new Date()): boolean {
    return this.props.expiresAt.getTime() < now.getTime();
  }

  // ── Transitions ────────────────────────────────────────────────────
  withPreviewCache(preview: unknown): ImportStaging {
    return new ImportStaging({ ...this.props, previewCache: preview });
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
