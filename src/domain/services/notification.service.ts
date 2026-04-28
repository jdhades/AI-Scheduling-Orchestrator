/**
 * Port: INotificationService
 *
 * Contrato de notificaciones en la capa de dominio.
 * Los handlers dependen de esta interfaz, NO de Twilio directamente.
 *
 * 💡 Dependency Inversion Principle (DIP):
 *    - High-level (handlers) → depende de la abstracción
 *    - Low-level (TwilioService) → implementa la abstracción
 *    Resultado: el dominio permanece AGNÓSTICO al proveedor de mensajería.
 */
export const NOTIFICATION_SERVICE = 'NOTIFICATION_SERVICE';

export interface INotificationService {
  /**
   * Envía un mensaje al número de WhatsApp indicado.
   * @param to   Número E.164 del destinatario, ej. "+34612345678"
   * @param body Texto del mensaje (max 1600 chars para WhatsApp)
   */
  sendWhatsApp(to: string, body: string): Promise<void>;
}
