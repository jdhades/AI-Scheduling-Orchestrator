import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { ShiftSwapRequestedEvent } from '../../domain/events/shift-swap-requested.event';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';

/**
 * ShiftSwapRequestedHandler
 *
 * Notifies both employees via WhatsApp when a swap is requested.
 */
@EventsHandler(ShiftSwapRequestedEvent)
export class ShiftSwapRequestedHandler implements IEventHandler<ShiftSwapRequestedEvent> {
  private readonly logger = new Logger(ShiftSwapRequestedHandler.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
  ) {}

  async handle(event: ShiftSwapRequestedEvent): Promise<void> {
    const { requesterId, targetEmployeeId, shiftId, companyId } = event;

    try {
      const [requester, target] = await Promise.all([
        this.employeeRepo.findById(requesterId, companyId),
        this.employeeRepo.findById(targetEmployeeId, companyId),
      ]);

      if (!requester || !target) {
        this.logger.warn(
          'Could not find employees for ShiftSwapRequestedEvent',
        );
        return;
      }

      // Notify the target employee about the swap request
      await this.notificationService.sendWhatsApp(
        target.phone,
        `🔄 *Solicitud de intercambio de turno*\n\n` +
          `*${requester.name}* te está pidiendo intercambiar un turno.\n\n` +
          `Para aceptar responde: "acepto el intercambio"\n` +
          `Para rechazar responde: "rechazo el intercambio"`,
      );

      // Confirm to the requester
      await this.notificationService.sendWhatsApp(
        requester.phone,
        `✉️ Tu solicitud de intercambio fue enviada a *${target.name}*. ` +
          `Te notificaremos cuando responda.`,
      );
    } catch (err) {
      this.logger.error(
        `ShiftSwapRequestedHandler failed: ${(err as Error).message}`,
      );
    }
  }
}
