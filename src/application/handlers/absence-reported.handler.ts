import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { AbsenceReportedEvent } from '../../domain/events/absence-reported.event';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { ManagerNotificationService } from '../services/manager-notification.service';

/**
 * AbsenceReportedHandler
 *
 * Notifica al manager cuando se reporta una ausencia. Phase 15.2 —
 * en vez del env var global `MANAGER_WHATSAPP_NUMBER`, usa
 * `ManagerNotificationService.notifyManagerForEmployee` que resuelve
 * el manager correcto según el depto del empleado origen
 * (con fallback al env var legacy si el tenant no configuró deptos).
 *
 * Si `isUrgent` (turno < 2h), prefijo con 🚨.
 */
@EventsHandler(AbsenceReportedEvent)
export class AbsenceReportedHandler implements IEventHandler<AbsenceReportedEvent> {
  private readonly logger = new Logger(AbsenceReportedHandler.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly managerNotifications: ManagerNotificationService,
  ) {}

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
        (isUrgent
          ? '🔴 Se necesita reemplazo urgente.'
          : 'Se necesita reasignar el turno.');

      await this.managerNotifications.notifyManagerForEmployee(
        companyId,
        employeeId,
        message,
      );
    } catch (err) {
      this.logger.error(
        `AbsenceReportedHandler failed: ${(err as Error).message}`,
      );
    }
  }
}
