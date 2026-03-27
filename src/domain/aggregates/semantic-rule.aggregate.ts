import { RulePriority } from '../value-objects/rule-priority.vo';
import { RuleType } from '../value-objects/rule-type.vo';
import { RuleEmbedding } from '../value-objects/rule-embedding.vo';

export interface SemanticRulePersistenceRow {
  id: string;
  company_id: string;
  rule_text: string;
  embedding: number[] | null;
  priority_level: number;
  rule_type: string;
  created_by: string | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string | Date;
}

/**
 * SemanticRuleAggregate — Aggregate Root
 *
 * Encapsula una regla de negocio escrita en lenguaje natural con sus invariantes:
 *   - El texto debe tener entre 10 y 1000 caracteres
 *   - El embedding tiene 768 dimensiones (Gemini text-embedding-004)
 *   - Al actualizar el texto, el embedding se invalida (requiere re-generación)
 *   - Una regla desactivada no puede reactivas directamente (requiere nuevo create)
 *   - Pertenece a exactamente una empresa (multi-tenant)
 *
 * Ciclo de vida:
 *   SemanticRuleAggregate.create() → no embedding
 *   → setEmbedding(vector)         → embedding válido, lista para persistir
 *   → updateText(newText)          → embedding invalidado, requiere re-embedding
 *   → deactivate()                 → soft-deleted, excluida de recuperación RAG
 */
export class SemanticRuleAggregate {
  private static readonly MIN_TEXT_LENGTH = 10;
  private static readonly MAX_TEXT_LENGTH = 1000;

  private constructor(
    private readonly id: string,
    private ruleText: string,
    private priority: RulePriority,
    private ruleType: RuleType,
    private readonly companyId: string,
    private embedding: RuleEmbedding | null,
    private isActive: boolean,
    private readonly createdBy: string | null,
    private readonly metadata: Record<string, unknown>,
    private readonly createdAt: Date,
  ) {}

  /**
   * Factory para crear una nueva regla semántica.
   * El embedding no se genera aquí — se asigna después via setEmbedding().
   */
  static create(params: {
    id: string;
    ruleText: string;
    priority: RulePriority;
    ruleType: RuleType;
    companyId: string;
    createdBy?: string;
    metadata?: Record<string, unknown>;
  }): SemanticRuleAggregate {
    SemanticRuleAggregate.validateRuleText(params.ruleText);

    return new SemanticRuleAggregate(
      params.id,
      params.ruleText.trim(),
      params.priority,
      params.ruleType,
      params.companyId,
      null,
      true,
      params.createdBy ?? null,
      params.metadata ?? {},
      new Date(),
    );
  }

  /**
   * Factory para reconstruir desde persistencia.
   * No dispara eventos de dominio (igual que en los aggregates del E2).
   */
  static fromPersistence(
    row: SemanticRulePersistenceRow,
  ): SemanticRuleAggregate {
    return new SemanticRuleAggregate(
      row.id,
      row.rule_text,
      RulePriority.create(row.priority_level),
      RuleType.create(row.rule_type),
      row.company_id,
      row.embedding ? RuleEmbedding.create(row.embedding) : null,
      row.is_active,
      row.created_by,
      row.metadata ?? {},
      new Date(row.created_at),
    );
  }

  // -------------------------------------------------------------------------
  // Comportamientos del dominio
  // -------------------------------------------------------------------------

  /**
   * Asigna el vector de embeddings generado por GeminiEmbeddingService.
   * @throws Error si el vector no tiene 768 dimensiones
   */
  setEmbedding(vector: number[]): void {
    this.embedding = RuleEmbedding.create(vector);
  }

  /**
   * Actualiza el texto de la regla e invalida el embedding actual.
   * El serivicio de aplicación deberá re-generar el embedding después.
   * @throws Error si el nuevo texto no cumple con los límites de longitud
   */
  updateText(newText: string): void {
    SemanticRuleAggregate.validateRuleText(newText);
    this.ruleText = newText.trim();
    this.embedding = null; // invalidar — requiere re-embedding
  }

  /**
   * Desactiva la regla (soft delete).
   * Las reglas inactivas no participan en el SemanticRetrievalService.
   */
  deactivate(): void {
    this.isActive = false;
  }

  // -------------------------------------------------------------------------
  // Estado / queries
  // -------------------------------------------------------------------------

  hasEmbedding(): boolean {
    return this.embedding !== null;
  }

  isReadyForRetrieval(): boolean {
    return this.isActive && this.hasEmbedding();
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  getId(): string {
    return this.id;
  }
  getRuleText(): string {
    return this.ruleText;
  }
  getPriority(): RulePriority {
    return this.priority;
  }
  getRuleType(): RuleType {
    return this.ruleType;
  }
  getCompanyId(): string {
    return this.companyId;
  }
  getEmbedding(): RuleEmbedding | null {
    return this.embedding;
  }
  getIsActive(): boolean {
    return this.isActive;
  }
  getCreatedBy(): string | null {
    return this.createdBy;
  }
  getMetadata(): Record<string, unknown> {
    return { ...this.metadata };
  }
  getCreatedAt(): Date {
    return this.createdAt;
  }

  // -------------------------------------------------------------------------
  // Privados / helpers
  // -------------------------------------------------------------------------

  private static validateRuleText(text: string): void {
    const trimmed = text?.trim() ?? '';
    if (trimmed.length < SemanticRuleAggregate.MIN_TEXT_LENGTH) {
      throw new Error(
        `Rule text is too short: ${trimmed.length} chars. Minimum: ${SemanticRuleAggregate.MIN_TEXT_LENGTH}`,
      );
    }
    if (trimmed.length > SemanticRuleAggregate.MAX_TEXT_LENGTH) {
      throw new Error(
        `Rule text is too long: ${trimmed.length} chars. Maximum: ${SemanticRuleAggregate.MAX_TEXT_LENGTH}`,
      );
    }
  }
}
