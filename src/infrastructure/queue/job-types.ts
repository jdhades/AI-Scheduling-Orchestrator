/**
 * Payload del job `schedule.generate`. El worker reconstruye el
 * `GenerateHybridScheduleCommand` a partir de estos campos y lo
 * dispatcha al CommandBus existente, reutilizando toda la lógica
 * (lock, runGeneration, fairness, NotificationsGateway).
 *
 * `source` lleva la info necesaria para que el worker, al terminar,
 * notifique de vuelta al originador:
 *   - http  → solo emite vía WS (el cliente HTTP polling /jobs/:id)
 *   - whatsapp → además dispara outbound Twilio al `from`
 */
export type ScheduleGenerationJobSource =
  | { type: 'http' }
  | {
      type: 'whatsapp';
      from: string;
      sessionContext?: Record<string, unknown>;
    };

export interface ScheduleGenerationJobPayload {
  companyId: string;
  weekStart: string; // ISO date — se normaliza al inicio-de-semana del tenant en el handler
  /**
   * Preferencia tenant para el inicio de semana. Se persiste en el
   * payload para que el worker normalice idénticamente al dispatcher,
   * sin volver a hitear `companies` desde el job handler.
   */
  weekStartsOn: 'sunday' | 'monday';
  departmentId?: string;
  shiftTemplateId?: string;
  locale?: string; // 'es' default
  source: ScheduleGenerationJobSource;
}

// ─── LLM job payloads (sprint async LLM) ────────────────────────────
// Shape común: cada job lleva `companyId` + `actorEmployeeId` para
// emitir el WS event tenant-scoped y para auditar quién disparó.

export interface CreateRuleJobPayload {
  companyId: string;
  actorEmployeeId: string | null;
  text: string;
  priority: number;
  ruleType: 'restriction' | 'preference' | 'requirement';
  scopeType?: 'company' | 'branch' | 'department' | 'employee';
  scopeId?: string | null;
}

export interface UpdateRuleTextJobPayload {
  companyId: string;
  actorEmployeeId: string | null;
  ruleId: string;
  newText: string;
}

/**
 * Policy creation async (sprint 2026-05-26). El handler reconstruye
 * la llamada a CompanyPolicyCreator desde estos campos.
 */
export interface CreatePolicyJobPayload {
  companyId: string;
  actorEmployeeId: string | null;
  text: string;
  severity: 'hard' | 'soft';
  scope?: {
    type: 'company' | 'branch' | 'department' | 'employee';
    id: string | null;
  };
  effectiveFrom?: string;
}

/**
 * Imports Fase 3 (upload libre). El upload llega al controller, sube
 * el archivo al bucket privado `import-uploads`, crea una row
 * `imports_staging` con status='extracting' y encola este job. El
 * worker descarga el archivo, llama al vision extractor del tenant,
 * setea payload + preview_cache y transiciona a 'pending_review'.
 */
export interface ImportsExtractJobPayload {
  companyId: string;
  actorEmployeeId: string | null;
  importId: string;
  storagePath: string;
  mimeType: string;
  originalName: string;
  /** UI locale del owner — para que warnings[].message del extractor
   * se devuelvan en su idioma. */
  locale: 'es' | 'en';
}
