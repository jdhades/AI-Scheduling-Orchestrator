/**
 * Constantes compartidas para validación de texto libre que el LLM
 * procesa downstream (rules semánticas y company policies).
 *
 * `MIN_FREE_TEXT_LENGTH` — debajo de este largo, el extractor no tiene
 * suficiente contexto para producir una estructura útil. Tunear acá
 * impacta tanto a `SemanticRuleAggregate` como a `CompanyPolicy`.
 */
export const MIN_FREE_TEXT_LENGTH = 10;
