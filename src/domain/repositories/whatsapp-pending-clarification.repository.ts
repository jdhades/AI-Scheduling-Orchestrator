import type { WhatsappPendingClarification } from '../aggregates/whatsapp-pending-clarification.aggregate';

export const WHATSAPP_PENDING_CLARIFICATION_REPOSITORY = Symbol(
  'WHATSAPP_PENDING_CLARIFICATION_REPOSITORY',
);

/**
 * IWhatsappPendingClarificationRepository — port de dominio.
 *
 * Persistencia del estado del suggestion-loop por WhatsApp. El
 * MessageRouter (cuando se integre) busca la pending entry del
 * empleado al recibir una respuesta, resuelve la sugerencia elegida,
 * y marca la entry como resolvedAt = NOW().
 */
export interface IWhatsappPendingClarificationRepository {
  save(entry: WhatsappPendingClarification): Promise<void>;

  /** La pending no resuelta y no expirada más reciente del empleado.
   *  Usado por el MessageRouter al recibir una respuesta numerada. */
  findActiveByEmployee(
    employeeId: string,
    companyId: string,
  ): Promise<WhatsappPendingClarification | null>;

  findById(
    id: string,
    companyId: string,
  ): Promise<WhatsappPendingClarification | null>;

  /** Marca como resuelta sin tocar el resto. Idempotente — re-llamarla
   *  no modifica resolvedAt si ya estaba seteado. */
  markResolved(id: string, companyId: string): Promise<void>;
}
