import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { I18nService } from 'nestjs-i18n';
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
    private readonly i18n: I18nService,
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
    } catch (err) {
      this.logger.error(
        `ShiftSwapRequestedHandler failed: ${(err as Error).message}`,
      );
    }
  }
}
