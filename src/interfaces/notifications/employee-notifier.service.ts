import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { I18nService } from 'nestjs-i18n';
import { ManagerNotificationService } from '../../application/services/manager-notification.service';
import {
  PushService,
  type LocalizedPushNotification,
} from '../../infrastructure/notifications/push.service';

const DEFAULT_LOCALE = 'en';

/**
 * EmployeeNotifier — fuente única para avisarle a un empleado por TODOS los
 * canales: WhatsApp (vía ManagerNotificationService) + push (Expo).
 *
 * El texto va por claves i18n y se traduce al idioma del empleado
 * (employees.locale): el push lo resuelve por destinatario internamente, y acá
 * resolvemos la locale una vez para el WhatsApp. Ambos envíos son best-effort y
 * fire-and-forget — la persistencia del aggregate ya ocurrió antes de llamar.
 */
@Injectable()
export class EmployeeNotifier {
  constructor(
    private readonly whatsapp: ManagerNotificationService,
    private readonly push: PushService,
    private readonly i18n: I18nService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  notify(
    companyId: string,
    employeeId: string,
    msg: LocalizedPushNotification,
  ): void {
    // Push: traduce por el idioma del destinatario.
    void this.push.sendLocalizedToEmployees(companyId, [employeeId], msg);
    // WhatsApp: resolver locale del empleado y traducir el body.
    void (async () => {
      const { data } = await this.supabase
        .from('employees')
        .select('locale')
        .eq('id', employeeId)
        .eq('company_id', companyId)
        .maybeSingle<{ locale: string | null }>();
      const lang = data?.locale || DEFAULT_LOCALE;
      const body = this.i18n.t(msg.bodyKey, { lang, args: msg.args }) as string;
      await this.whatsapp.notifyEmployee(companyId, employeeId, body);
    })();
  }
}
