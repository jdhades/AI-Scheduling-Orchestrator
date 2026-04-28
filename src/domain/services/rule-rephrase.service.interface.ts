/**
 * RuleRephraseService — Port de dominio.
 *
 * Cuando una CompanyPolicy o SemanticRule no puede ser estructurada por
 * el sistema (ningún interpreter matcheó / el extractor LLM marcó la
 * regla como `intent: complex`), este servicio le pide a un LLM 2-3
 * reformulaciones que SÍ se puedan estructurar. El manager elige una y
 * el create se reintenta con el texto elegido.
 *
 * Implementación llama al ILLMService y verifica cada sugerencia contra
 * el PolicyInterpreterRegistry — si el LLM hallucina una sugerencia que
 * no matchea, se filtra antes de devolverla. Esto evita el caso "el bot
 * me dijo que esto se podía aplicar pero no se pudo" en el suggestion
 * loop.
 */
export const RULE_REPHRASE_SERVICE = Symbol('RULE_REPHRASE_SERVICE');

export type RephraseReason =
  /** El registry no encontró ningún interpreter que matcheara el texto. */
  | 'no_interpreter_matched'
  /** El extractor LLM marcó intent=complex (texto ambiguo / counting / etc.). */
  | 'intent_complex';

export interface RephraseInterpreterHint {
  /** Identificador del interpreter (ej. 'min_rest_days_per_week'). */
  id: string;
  /** Descripción humana — el LLM la usa para entender qué patrón aplica. */
  description: string;
}

export interface RephraseInput {
  originalText: string;
  reason: RephraseReason;
  /** Razón estructural (ej. complexReason del extractor). Opcional. */
  reasonDetail?: string;
  /** Catálogo de interpreters disponibles — el LLM apunta sus
   *  reformulaciones a alguno de ellos. */
  interpreters: RephraseInterpreterHint[];
}

export interface RephraseSuggestion {
  /** UUID estable que el frontend usa para tracking de cuál se eligió. */
  id: string;
  /** Texto reformulado en lenguaje natural — apto para re-submitear como
   *  texto de la policy. */
  suggestedText: string;
  /** El interpreter que matcheó esta sugerencia (verificado, no LLM-claim). */
  matchedInterpreterId: string;
  /** Preview de los params que el sistema extraería al re-submitear con
   *  este texto. */
  matchedParams: Record<string, unknown>;
  /** Explicación corta de por qué esta sugerencia es aplicable. */
  explanation: string;
}

export interface IRuleRephraseService {
  /**
   * Devuelve hasta N sugerencias verificadas (cada una matchea contra
   * algún interpreter del registry). Lista vacía si el LLM falló o no
   * pudo proponer reformulaciones aplicables.
   */
  suggest(input: RephraseInput): Promise<RephraseSuggestion[]>;
}
