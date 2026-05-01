import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { I18nService } from 'nestjs-i18n';
import { Inject, Logger } from '@nestjs/common';
import { ShiftSwapRequestedEvent } from '../../domain/events/shift-swap-requested.event';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { ManagerNotificationService } from '../services/manager-notification.service';

/**
 * ShiftSwapRequestedHandler
 *
 * Notifica:
 *   - Al target employee (que su compañero le pide swap).
 *   - Al requester (confirmación).
 *   - Phase 15.2: Al manager del depto del requester (para que
 *     pueda aprobar/rechazar). Antes nadie le avisaba al manager
 *     y el swap se quedaba en pending hasta que abriera el panel.
 */
@EventsHandler(ShiftSwapRequestedEvent)
export class ShiftSwapRequestedHandler implements IEventHandler<ShiftSwapRequestedEvent> {
  private readonly logger = new Logger(ShiftSwapRequestedHandler.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
    private readonly i18n: I18nService,
    private readonly managerNotifications: ManagerNotificationService,
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
        this.i18n.t('bot.swap.notification_target', {
          lang: target.locale,
          args: { requesterName: requester.name },
        }),
      );

      // Confirm to the requester
      await this.notificationService.sendWhatsApp(
        requester.phone,
        this.i18n.t('bot.swap.notification_requester', {
          lang: requester.locale,
          args: { targetName: target.name },
        }),
      );

      // Phase 15.2 — alertar al manager del depto del requester.
      // Mensaje en es-AR (bot del proyecto). Si querés multi-locale,
      // mover a i18n con namespace `bot.swap.notification_manager`.
      const managerMessage =
        '🔄 *Solicitud de intercambio de turno*\n\n' +
        `*Solicitante:* ${requester.name} (${requester.phone})\n` +
        `*Destinatario:* ${target.name} (${target.phone})\n` +
        `*Turno:* ${shiftId}\n\n` +
        'Aprobá o rechazá desde el panel.';

      await this.managerNotifications.notifyManagerForEmployee(
        companyId,
        requesterId,
        managerMessage,
      );
    } catch (err) {
      this.logger.error(
        `ShiftSwapRequestedHandler failed: ${(err as Error).message}`,
      );
    }
  }
}
