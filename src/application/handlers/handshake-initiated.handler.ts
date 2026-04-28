import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { HandshakeInitiatedEvent } from '../../domain/events/handshake-initiated.event';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { INotificationService } from '../../domain/services/notification.service';

/**
 * EventsHandler: HandshakeInitiatedHandler
 *
 * Reacciona al HandshakeInitiatedEvent disparado por WhatsappHandshake.initiate().
 *
 * Responsabilidad: enviar el token UUID al número WhatsApp del empleado
 * para completar el flujo de vinculación de cuenta.
 *
 * 💡 Observer Pattern: este handler es el "Observer" que reacciona
 *    al evento. El aggregate no sabe que Twilio existe — solo dispara el evento.
 */
@EventsHandler(HandshakeInitiatedEvent)
export class HandshakeInitiatedHandler implements IEventHandler<HandshakeInitiatedEvent> {
  constructor(
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
  ) {}

  async handle(event: HandshakeInitiatedEvent): Promise<void> {
    const message =
      `🔐 Tu código de verificación de WhatsApp es:\n\n` +
      `*${event.token}*\n\n` +
      `Este código expira en 15 minutos. No lo compartas con nadie.`;

    await this.notificationService.sendWhatsApp(event.phone, message);
  }
}
