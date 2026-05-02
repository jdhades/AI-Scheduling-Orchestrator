import { DomainError } from '../errors/domain.error';

// ─── Intent Types ─────────────────────────────────────────────────────────────

export type IntentType =
  | 'swap_shift'
  | 'report_absence'
  | 'check_schedule'
  | 'request_day_off'
  | 'generate_schedule'
  | 'select_option'
  | 'create_rule'
  /** Estado interno: el manager está respondiendo a una lista numerada
   *  de sugerencias generadas por el LLM tras un intento de create_rule
   *  que dio intent=complex. No lo emite el clasificador externo —
   *  el MessageRouter lo setea via session.withIntent() para mantener
   *  contexto entre mensajes. */
  | 'create_rule_clarification'
  /** El manager dicta una política tenant-wide (aplica a todos los
   *  empleados), distinta de create_rule que es caso particular. */
  | 'create_policy'
  /** Análogo a create_rule_clarification pero para policies. Estado
   *  interno seteado por el MessageRouter cuando hay una pending
   *  WhatsappPendingClarification con target_kind='policy'. */
  | 'create_policy_clarification'
  | 'system_unavailable'
  | 'unknown';

export interface IntentEntities {
  date?: string; // ISO 8601 date string
  targetEmployeePhone?: string; // E.164 format
  shiftId?: string; // UUID of the shift
  reason?: string; // free text
  weekStart?: string; // ISO 8601 date (YYYY-MM-DD) — for generate_schedule
  timeOfDay?: string; // 'morning', 'afternoon', 'night', etc.
  selection?: string; // '1', '2', 'yes', 'no'
  ruleText?: string; // the rule dictated by the manager
  expiresAt?: string; // ISO 8601 date (YYYY-MM-DD) when the rule expires, if applicable
  detectedLanguage?: string; // ISO 639-1 code (e.g. 'en', 'es', 'pt')
  /**
   * Phase 14.2 — alcance al que aplica la policy/regla (sólo create_policy).
   * El LLM lo extrae del texto del manager: "para el departamento de seguridad"
   * → scopeType="department", scopeName="seguridad". MessageRouter resuelve
   * scopeName → scope_id contra la BD del tenant.
   */
  scopeType?: 'company' | 'branch' | 'department' | 'employee';
  scopeName?: string;
  /**
   * Phase 18.4 — período (YYYY-MM-DD) para report_absence / request_day_off.
   * Single-day: start === end (o solo `date` legacy). Multi-day: start < end.
   */
  startDate?: string;
  endDate?: string;
  /**
   * Phase 18.4 — nombre del empleado target cuando el manager reporta
   * on-behalf ("ausencia de María del lunes al martes"). MessageRouter
   * resuelve el nombre → employeeId vía fuzzy match. Si el remitente
   * no es manager, se ignora.
   */
  targetEmployeeName?: string;
  [key: string]: any; // Allow dynamic properties for session state
}

// ─── ConversationIntentVO ─────────────────────────────────────────────────────

/**
 * Value Object that encapsulates the result of Gemini's intent classification.
 *
 * Immutable — created once from the Gemini response and passed downstream.
 */
export class ConversationIntentVO {
  private static readonly VALID_INTENTS: IntentType[] = [
    'swap_shift',
    'report_absence',
    'check_schedule',
    'request_day_off',
    'generate_schedule',
    'select_option',
    'create_rule',
    'create_rule_clarification',
    'create_policy',
    'create_policy_clarification',
    'system_unavailable',
    'unknown',
  ];

  private static readonly ACTIONABLE_CONFIDENCE_THRESHOLD = 0.6;

  private constructor(
    private readonly _intent: IntentType,
    private readonly _confidence: number,
    private readonly _entities: IntentEntities,
    private readonly _rawText: string,
  ) {}

  // ─── Factory ──────────────────────────────────────────────────────────────

  static create(params: {
    intent: IntentType;
    confidence: number;
    entities: IntentEntities;
    rawText: string;
  }): ConversationIntentVO {
    if (!ConversationIntentVO.VALID_INTENTS.includes(params.intent)) {
      throw new DomainError(
        `Invalid intent type: "${params.intent}". ` +
          `Must be one of: ${ConversationIntentVO.VALID_INTENTS.join(', ')}`,
      );
    }
    if (params.confidence < 0 || params.confidence > 1) {
      throw new DomainError(
        `Confidence must be between 0 and 1, got: ${params.confidence}`,
      );
    }
    if (!params.rawText || params.rawText.trim().length === 0) {
      throw new DomainError('rawText cannot be empty');
    }

    return new ConversationIntentVO(
      params.intent,
      params.confidence,
      { ...params.entities }, // defensive copy
      params.rawText,
    );
  }

  static unknown(rawText = ''): ConversationIntentVO {
    return new ConversationIntentVO('unknown', 0, {}, rawText);
  }

  /** Creates a fallback intent for when Gemini faces Rate Limits (429) */
  static systemUnavailable(rawText = ''): ConversationIntentVO {
    return new ConversationIntentVO('system_unavailable', 1, {}, rawText);
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getIntent(): IntentType {
    return this._intent;
  }
  getConfidence(): number {
    return this._confidence;
  }
  getEntities(): Readonly<IntentEntities> {
    return { ...this._entities };
  }
  getRawText(): string {
    return this._rawText;
  }

  // ─── Business logic ───────────────────────────────────────────────────────

  /**
   * Returns true when the intent is known AND confidence is high enough
   * to proceed with command execution (no human fallback needed).
   */
  isActionable(): boolean {
    return (
      this._intent !== 'unknown' &&
      this._confidence >= ConversationIntentVO.ACTIONABLE_CONFIDENCE_THRESHOLD
    );
  }

  isUnknown(): boolean {
    return this._intent === 'unknown';
  }

  /**
   * Returns fields that are required for this intent but missing from entities.
   */
  getMissingFields(): string[] {
    const required: Record<IntentType, string[]> = {
      swap_shift: [],
      report_absence: ['shiftId', 'reason'],
      check_schedule: [],
      request_day_off: ['date'],
      generate_schedule: ['weekStart'],
      select_option: [],
      create_rule: ['ruleText'],
      create_rule_clarification: [],
      create_policy: ['ruleText'],
      create_policy_clarification: [],
      system_unavailable: [],
      unknown: [],
    };

    return (required[this._intent] ?? []).filter(
      (field) => !this._entities[field],
    );
  }

  isComplete(): boolean {
    return this.getMissingFields().length === 0;
  }
}
