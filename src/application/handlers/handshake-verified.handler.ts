import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { HandshakeVerifiedEvent } from '../../domain/events/handshake-verified.event';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { INotificationService } from '../../domain/services/notification.service';

/**
 * EventsHandler: HandshakeVerifiedHandler
 *
 * Reacciona al HandshakeVerifiedEvent disparado por WhatsappHandshake.verify().
 *
 * Responsabilidades:
 *  1. Marcar whatsapp_verified = true en el registro del empleado.
 *  2. Enviar mensaje de confirmación al empleado vía WhatsApp.
 *
 * 💡 Observer Pattern: dos efectos colaterales de un solo evento,
 *    sin que el aggregate conozca ninguno de los dos.
 */
@EventsHandler(HandshakeVerifiedEvent)
export class HandshakeVerifiedHandler
    implements IEventHandler<HandshakeVerifiedEvent> {
    constructor(
        @Inject(EMPLOYEE_REPOSITORY)
        private readonly employeeRepository: IEmployeeRepository,
        @Inject(NOTIFICATION_SERVICE)
        private readonly notificationService: INotificationService,
    ) { }

    async handle(event: HandshakeVerifiedEvent): Promise<void> {
        // 1. Persistir: marcar en base de datos
        await this.employeeRepository.markWhatsappVerified(event.employeeId);

        // 2. Notificar: confirmación al empleado
        const message =
            `✅ ¡Tu WhatsApp ha sido verificado correctamente!\n\n` +
            `Ya puedes usar el asistente de turnos. Envía un mensaje de audio ` +
            `o texto para empezar.`;

        await this.notificationService.sendWhatsApp(event.phone, message);
    }
}
