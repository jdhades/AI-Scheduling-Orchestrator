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
  | { type: 'whatsapp'; from: string; sessionContext?: Record<string, unknown> };

export interface ScheduleGenerationJobPayload {
  companyId: string;
  weekStart: string; // ISO date — se normaliza al lunes en el handler
  departmentId?: string;
  shiftTemplateId?: string;
  locale?: string; // 'es' default
  source: ScheduleGenerationJobSource;
}
