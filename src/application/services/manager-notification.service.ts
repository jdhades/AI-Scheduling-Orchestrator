import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';

/**
 * ManagerNotificationService — resuelve a qué manager mandarle una
 * notificación originada por un employee y dispara el envío via WhatsApp.
 *
 * Lookup, en orden:
 *   1. department.manager_employee_id del depto del empleado origen
 *      (Phase 15.1) → su phone.
 *   2. Cualquier employee del tenant con role='manager' (orden alfabético
 *      por nombre para determinismo) → su phone.
 *   3. process.env.MANAGER_WHATSAPP_NUMBER (compatibilidad con seed legacy
 *      donde no había manager_employee_id ni un manager real en BD).
 *   4. Si nada matchea: log warning y skip — la notificación no se manda
 *      pero el flow del aggregate igual continúa.
 *
 * Devuelve `true` si se mandó una notificación, `false` en caso contrario.
 * Los errores de Twilio NO se propagan (se loguean): el aggregate ya está
 * persistido y un fallo de delivery no debe romper el handler.
 */
@Injectable()
export class ManagerNotificationService {
  private readonly logger = new Logger(ManagerNotificationService.name);
  private readonly fallbackPhone: string;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
  ) {
    this.fallbackPhone = process.env.MANAGER_WHATSAPP_NUMBER ?? '';
  }

  async notifyManagerForEmployee(
    companyId: string,
    employeeId: string,
    message: string,
  ): Promise<boolean> {
    const phone = await this.resolveManagerPhone(companyId, employeeId);
    if (!phone) {
      this.logger.warn(
        `No manager could be resolved for employee ${employeeId} ` +
          `in company ${companyId}; skipping notification.`,
      );
      return false;
    }

    try {
      await this.notificationService.sendWhatsApp(phone, message);
      return true;
    } catch (err) {
      this.logger.error(
        `notifyManagerForEmployee delivery failed (phone=${phone}): ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  /**
   * Expone el lookup sin disparar el envío — útil para handlers que
   * necesitan combinar varios mensajes o re-usar el phone para otra cosa.
   */
  async resolveManagerPhone(
    companyId: string,
    employeeId: string,
  ): Promise<string | null> {
    // 1. Manager designado del depto del empleado.
    const empRow = await this.supabase
      .from('employees')
      .select('department_id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (empRow.error) {
      this.logger.warn(
        `resolveManagerPhone: employee lookup failed: ${empRow.error.message}`,
      );
    }
    const departmentId = empRow.data?.department_id as string | undefined;

    if (departmentId) {
      const dept = await this.supabase
        .from('departments')
        .select('manager_employee_id')
        .eq('id', departmentId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (dept.error) {
        this.logger.warn(
          `resolveManagerPhone: department lookup failed: ${dept.error.message}`,
        );
      }
      const managerEmployeeId = dept.data?.manager_employee_id as
        | string
        | undefined;
      if (managerEmployeeId) {
        const phone = await this.lookupEmployeePhone(
          companyId,
          managerEmployeeId,
        );
        if (phone) return phone;
      }
    }

    // 2. Cualquier manager del tenant.
    const anyManager = await this.supabase
      .from('employees')
      .select('phone_number')
      .eq('company_id', companyId)
      .eq('role', 'manager')
      .order('name', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (anyManager.error) {
      this.logger.warn(
        `resolveManagerPhone: any-manager fallback failed: ${anyManager.error.message}`,
      );
    }
    const fallbackPhone = anyManager.data?.phone_number as string | undefined;
    if (fallbackPhone) return fallbackPhone;

    // 3. Env var legacy (compatibilidad con seeds viejos).
    return this.fallbackPhone || null;
  }

  private async lookupEmployeePhone(
    companyId: string,
    employeeId: string,
  ): Promise<string | null> {
    const row = await this.supabase
      .from('employees')
      .select('phone_number')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (row.error) {
      this.logger.warn(
        `lookupEmployeePhone failed for ${employeeId}: ${row.error.message}`,
      );
      return null;
    }
    return (row.data?.phone_number as string | undefined) ?? null;
  }
}
