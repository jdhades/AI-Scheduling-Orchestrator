import { Injectable } from '@nestjs/common';
import { ManagerNotificationService } from '../../application/services/manager-notification.service';
import { PushService } from '../../infrastructure/notifications/push.service';

/**
 * EmployeeNotifier — fuente única para avisarle a un empleado por TODOS los
 * canales: WhatsApp (vía ManagerNotificationService) + push (Expo).
 *
 * Ambos envíos son best-effort y fire-and-forget — la persistencia del
 * aggregate ya ocurrió antes de llamar acá; un fallo de delivery no debe
 * romper el handler. Reúne los dos servicios en interfaces (donde ambos son
 * alcanzables) para no inyectar PushService en cada controller ni cruzar el
 * límite de módulos application→interfaces.
 */
@Injectable()
export class EmployeeNotifier {
  constructor(
    private readonly whatsapp: ManagerNotificationService,
    private readonly push: PushService,
  ) {}

  /**
   * @param push.title  título del push (default 'Novedad')
   * @param push.data   payload para deep-link (ej. `{ type: 'approval' }`)
   */
  notify(
    companyId: string,
    employeeId: string,
    message: string,
    push?: { title?: string; data?: Record<string, unknown> },
  ): void {
    void this.whatsapp.notifyEmployee(companyId, employeeId, message);
    void this.push.sendToEmployees(companyId, [employeeId], {
      title: push?.title ?? 'Novedad',
      body: message,
      data: push?.data ?? {},
    });
  }
}
