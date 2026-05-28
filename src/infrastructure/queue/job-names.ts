/**
 * Job names para pg-boss. Centralizar acá evita typos sueltos en el
 * codebase. Nuevos jobs: agregar la constante, definir el payload en
 * types.ts y registrar el handler en el módulo.
 */
export const JOB_SCHEDULE_GENERATE = 'schedule.generate';

/**
 * Dead-letter queue para `schedule.generate`. pg-boss copia el
 * payload acá cuando se exhaustan los retries del job principal.
 * El worker dedicado notifica al manager (Twilio outbound) y loguea.
 */
export const JOB_SCHEDULE_GENERATE_DEAD = 'schedule.generate.dead';

// ─── LLM jobs (sprint async LLM 2026-05-19) ─────────────────────────
// Solo flows con UI sync entran acá. policy=standard, retryLimit=0,
// expire=600s. WS events: LlmJobStarted/Completed/Failed con shape
// `{ jobId, type, companyId, result|error }`.
//
// process_incident_evidence corre por consumer interno
// (vision-processing.consumer) sin endpoint HTTP — no aplica.
export const JOB_LLM_CREATE_RULE = 'llm.create_rule';
export const JOB_LLM_UPDATE_RULE_TEXT = 'llm.update_rule_text';
/**
 * Policy creation async (sprint async-policies 2026-05-26). Antes era
 * síncrono — el HTTP request blocking-ueaba ~20-30s mientras Qwen
 * matcheaba interpreters. Movido a queue: response 202+jobId al toque,
 * WS event al terminar.
 */
export const JOB_LLM_CREATE_POLICY = 'llm.create_policy';

/**
 * Imports Fase 3: extracción async de PDF/imagen subido por el owner
 * con vision LLM (Anthropic/Gemini/Qwen). El payload pasa al spine de
 * staging (Fase 1) — el WS event lleva el `importId` para que el
 * frontend navegue a /imports/:id/preview.
 */
export const JOB_IMPORTS_EXTRACT = 'imports.extract';

/** Tipos válidos para identificar el job en WS events / store frontend.
 * Mantener sync con las constantes de queue de arriba. */
export type LlmJobType =
  | 'create_rule'
  | 'update_rule_text'
  | 'create_policy'
  | 'imports_extract';

/** Map type → queue name. Centralizado para evitar typos en el wiring. */
export const LLM_JOB_QUEUE_BY_TYPE: Record<LlmJobType, string> = {
  create_rule: JOB_LLM_CREATE_RULE,
  update_rule_text: JOB_LLM_UPDATE_RULE_TEXT,
  create_policy: JOB_LLM_CREATE_POLICY,
  imports_extract: JOB_IMPORTS_EXTRACT,
};
