import { randomUUID } from 'crypto';

/**
 * WhatsappPendingClarification — Aggregate Root
 *
 * Estado de un suggestion-loop activo por WhatsApp. Cuando el manager
 * escribe un texto de policy/rule que requiere clarificación, el bot
 * persiste esta entrada con las sugerencias generadas y espera la
 * respuesta. Cuando el manager responde con un número o texto libre,
 * el sistema busca la pending entry, resuelve y crea la entidad final.
 *
 * Invariantes:
 *  - targetKind ∈ {'policy', 'rule'}
 *  - suggestions es una lista no vacía
 *  - expiresAt > createdAt (típicamente +10 min desde create)
 */
export type WhatsappTargetKind = 'policy' | 'rule';

/** Subset que persistimos por sugerencia. Lo mínimo para que al resolver
 *  podamos mostrar/usar el texto y cualquier metadata útil. */
export interface PersistedSuggestion {
  id: string;
  suggestedText: string;
  /** Metadata libre — cada flow (policy / rule) define su shape. */
  meta?: Record<string, unknown>;
}

export interface WhatsappPendingClarificationProps {
  id: string;
  employeeId: string;
  companyId: string;
  targetKind: WhatsappTargetKind;
  originalText: string;
  suggestions: PersistedSuggestion[];
  expiresAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface CreatePendingClarificationInput {
  employeeId: string;
  companyId: string;
  targetKind: WhatsappTargetKind;
  originalText: string;
  suggestions: PersistedSuggestion[];
  /** TTL en segundos. Default: 600 (10 min). */
  ttlSeconds?: number;
  /** Permite forzar el id (testing / seeding). */
  id?: string;
}

const DEFAULT_TTL_SECONDS = 600;

export class WhatsappPendingClarification {
  private constructor(
    private readonly props: WhatsappPendingClarificationProps,
  ) {}

  static create(
    input: CreatePendingClarificationInput,
  ): WhatsappPendingClarification {
    if (input.suggestions.length === 0) {
      throw new Error(
        'WhatsappPendingClarification requires at least one suggestion.',
      );
    }
    const now = new Date();
    const ttl = (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    return new WhatsappPendingClarification({
      id: input.id ?? randomUUID(),
      employeeId: input.employeeId,
      companyId: input.companyId,
      targetKind: input.targetKind,
      originalText: input.originalText,
      suggestions: input.suggestions,
      expiresAt: new Date(now.getTime() + ttl),
      createdAt: now,
      resolvedAt: null,
    });
  }

  static fromPersistence(
    props: WhatsappPendingClarificationProps,
  ): WhatsappPendingClarification {
    return new WhatsappPendingClarification(props);
  }

  /** Resuelve la pending entry — el caller debe llamar antes de actuar
   *  sobre la sugerencia elegida. Idempotente: si ya estaba resuelta no
   *  cambia el resolvedAt. */
  resolve(when: Date = new Date()): void {
    if (this.props.resolvedAt === null) {
      this.props.resolvedAt = when;
    }
  }

  isExpired(at: Date = new Date()): boolean {
    return at >= this.props.expiresAt;
  }

  isResolved(): boolean {
    return this.props.resolvedAt !== null;
  }

  /** Busca una sugerencia por su número de orden (1-indexed, como en
   *  WhatsApp). Devuelve null si está fuera de rango. */
  pickByNumber(n: number): PersistedSuggestion | null {
    if (n < 1 || n > this.props.suggestions.length) return null;
    return this.props.suggestions[n - 1];
  }

  // -- Getters ----------------------------------------------------------
  getId(): string {
    return this.props.id;
  }
  getEmployeeId(): string {
    return this.props.employeeId;
  }
  getCompanyId(): string {
    return this.props.companyId;
  }
  getTargetKind(): WhatsappTargetKind {
    return this.props.targetKind;
  }
  getOriginalText(): string {
    return this.props.originalText;
  }
  getSuggestions(): readonly PersistedSuggestion[] {
    return this.props.suggestions;
  }
  getExpiresAt(): Date {
    return this.props.expiresAt;
  }
  getCreatedAt(): Date {
    return this.props.createdAt;
  }
  getResolvedAt(): Date | null {
    return this.props.resolvedAt;
  }

  toSnapshot(): WhatsappPendingClarificationProps {
    return {
      ...this.props,
      suggestions: this.props.suggestions.map((s) => ({ ...s })),
    };
  }
}
