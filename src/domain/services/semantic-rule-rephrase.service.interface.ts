/**
 * SemanticRuleRephraseService — port de dominio.
 *
 * Cuando el RuleStructureExtractor marca una regla como
 * `intent: 'complex'` (texto ambiguo / counting / sin sujeto), este
 * servicio le pide al LLM 2-3 reformulaciones que SÍ encajen en el
 * matcher schema de SemanticRule (employeeMatchers, dateMatchers,
 * hourRangeMatchers, shiftNameMatchers).
 *
 * A diferencia del PolicyRephraseService (commit 4), las sugerencias
 * NO se pre-verifican: el matcher schema solo se valida con otra
 * corrida del structure-extractor (otro LLM call), lo que multiplicaría
 * la latencia. La verificación real ocurre cuando el manager elige una
 * sugerencia y el frontend re-submitea — el flow estándar de create
 * vuelve a correr el extractor. Si el LLM otra vez devuelve complex,
 * el loop se repite con nuevas sugerencias.
 */
export const SEMANTIC_RULE_REPHRASE_SERVICE = Symbol(
  'SEMANTIC_RULE_REPHRASE_SERVICE',
);

export interface SemanticRuleRephraseInput {
  originalText: string;
  /** Razón estructural devuelta por el extractor (RuleStructure.complexReason). */
  complexReason: string;
}

export interface SemanticRuleSuggestion {
  /** UUID estable para tracking en el frontend. */
  id: string;
  /** Texto reformulado, listo para re-submitear. */
  suggestedText: string;
  /** Explicación corta de por qué esta versión es más aplicable. */
  explanation: string;
  /** Intent estimado por el LLM (ej. 'block', 'permit-multi-shift',
   *  'preference'). Solo informativo — la verificación real sucede al
   *  re-submit. */
  previewIntent?: string;
}

export interface ISemanticRuleRephraseService {
  /** Devuelve hasta 3 sugerencias. Lista vacía si el LLM falló. */
  suggest(input: SemanticRuleRephraseInput): Promise<SemanticRuleSuggestion[]>;
}
