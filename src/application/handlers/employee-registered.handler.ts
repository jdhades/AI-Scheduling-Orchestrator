import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { EmployeeRegisteredEvent } from '../../domain/events/employee-registered.event';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { INotificationService } from '../../domain/services/notification.service';

/**
 * EventsHandler: EmployeeRegisteredHandler
 *
 * Escucha el EmployeeRegisteredEvent que el Employee aggregate
 * despacha al hacer commit() en RegisterEmployeeHandler.
 *
 * Responsabilidades:
 *  - Enviar mensaje de bienvenida al empleado vía WhatsApp
 *  - Informarle que necesita completar la vinculación de cuenta
 *
 * 💡 Observer Pattern: el aggregate dispara el evento;
 *    este handler reacciona de forma desacoplada y completamente
 *    transparente para el dominio.
 */
@EventsHandler(EmployeeRegisteredEvent)
export class EmployeeRegisteredHandler implements IEventHandler<EmployeeRegisteredEvent> {
  constructor(
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
  ) {}

  async handle(event: EmployeeRegisteredEvent): Promise<void> {
    const message =
      `👋 ¡Bienvenido al sistema de turnos!\n\n` +
      `Para completar tu registro, un administrador iniciará la ` +
      `verificación de tu cuenta. Recibirás un código de confirmación ` +
      `en breve.\n\n` +
      `_Este mensaje es automático — no respondas a este número._`;

    await this.notificationService.sendWhatsApp(event.phone, message);
  }
}
