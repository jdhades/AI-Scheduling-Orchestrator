import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { AbsenceReportedEvent } from '../../domain/events/absence-reported.event';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';

/**
 * AbsenceReportedHandler
 *
 * Notifies the manager when an absence is reported.
 * If isUrgent (shift starts in < 2 hours), escalates with a 🚨 alert.
 */
@EventsHandler(AbsenceReportedEvent)
export class AbsenceReportedHandler implements IEventHandler<AbsenceReportedEvent> {
    private readonly logger = new Logger(AbsenceReportedHandler.name);
    private readonly managerPhone: string;

    constructor(
        @Inject(EMPLOYEE_REPOSITORY) private readonly employeeRepo: IEmployeeRepository,
        @Inject(NOTIFICATION_SERVICE) private readonly notificationService: INotificationService,
    ) {
        this.managerPhone = process.env.MANAGER_WHATSAPP_NUMBER ?? '';
    }

    async handle(event: AbsenceReportedEvent): Promise<void> {
        const { employeeId, shiftId, reason, companyId, isUrgent } = event;

        try {
            const employee = await this.employeeRepo.findById(employeeId, companyId);
            if (!employee) return;

            const urgencyPrefix = isUrgent
                ? '🚨 *ALERTA URGENTE* — Turno en menos de 2 horas\n'
                : '⚠️ *Ausencia reportada*\n';

            const message =
                `${urgencyPrefix}\n` +
                `*Empleado:* ${employee.phone}\n` +
                `*Turno:* ${shiftId}\n` +
                `*Motivo:* ${reason}\n\n` +
                (isUrgent ? '🔴 Se necesita reemplazo urgente.' : 'Se necesita reasignar el turno.');

            if (this.managerPhone) {
                await this.notificationService.sendWhatsApp(this.managerPhone, message);
            } else {
                this.logger.warn('MANAGER_WHATSAPP_NUMBER not configured — manager not notified');
            }
        } catch (err) {
            this.logger.error(`AbsenceReportedHandler failed: ${(err as Error).message}`);
        }
    }
}
