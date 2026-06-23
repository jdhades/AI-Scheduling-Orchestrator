import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { I18nService } from 'nestjs-i18n';

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Notificación localizada: las claves se traducen al idioma de cada
 *  destinatario (employees.locale) antes de enviar. */
export interface LocalizedPushNotification {
  titleKey: string;
  bodyKey: string;
  /** Args de interpolación de i18n (ej. { date }). */
  args?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
}

const DEFAULT_LOCALE = 'en';

/**
 * Sends push notifications via the Expo Push API to the employees' registered
 * devices. Best-effort + batched (Expo caps 100 messages/request). v1 sends
 * inline fire-and-forget; can move behind pg-boss for retries/throughput later.
 *
 * Dos formas:
 *   - sendToEmployees: texto literal (ej. contenido de un mensaje de chat).
 *   - sendLocalizedToEmployees: traduce por el idioma de CADA destinatario
 *     (employees.locale) — para notificaciones del sistema (turnos, aprobaciones).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private static readonly EXPO_URL = 'https://exp.host/--/api/v2/push/send';

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly i18n: I18nService,
  ) {}

  /** Texto literal a todos los devices de los empleados (mismo título/body). */
  async sendToEmployees(
    companyId: string,
    employeeIds: string[],
    n: PushNotification,
  ): Promise<void> {
    const ids = [...new Set(employeeIds)].filter(Boolean);
    if (ids.length === 0) return;
    const { data: rows } = await this.supabase
      .from('device_tokens')
      .select('token')
      .eq('company_id', companyId)
      .in('employee_id', ids);
    const tokens = (rows ?? []).map((r) => r.token as string);
    if (tokens.length === 0) return;

    await this.dispatch(
      tokens.map((to) => ({
        to,
        title: n.title,
        body: n.body,
        data: n.data ?? {},
        sound: 'default' as const,
      })),
    );
  }

  /**
   * Notificación del sistema traducida al idioma de cada destinatario.
   * Resuelve employees.locale por empleado (fallback 'en') y traduce
   * title/body con i18n antes de armar cada mensaje.
   */
  async sendLocalizedToEmployees(
    companyId: string,
    employeeIds: string[],
    n: LocalizedPushNotification,
  ): Promise<void> {
    const ids = [...new Set(employeeIds)].filter(Boolean);
    if (ids.length === 0) return;
    const [tokensRes, localesRes] = await Promise.all([
      this.supabase
        .from('device_tokens')
        .select('token, employee_id')
        .eq('company_id', companyId)
        .in('employee_id', ids),
      this.supabase
        .from('employees')
        .select('id, locale')
        .eq('company_id', companyId)
        .in('id', ids),
    ]);
    const tokenRows = (tokensRes.data ?? []) as Array<{
      token: string;
      employee_id: string;
    }>;
    if (tokenRows.length === 0) return;
    const localeOf = new Map(
      (
        (localesRes.data ?? []) as Array<{ id: string; locale: string | null }>
      ).map((e) => [e.id, e.locale || DEFAULT_LOCALE]),
    );

    await this.dispatch(
      tokenRows.map((r) => {
        const lang = localeOf.get(r.employee_id) ?? DEFAULT_LOCALE;
        return {
          to: r.token,
          title: this.i18n.t(n.titleKey, { lang, args: n.args }),
          body: this.i18n.t(n.bodyKey, { lang, args: n.args }),
          data: n.data ?? {},
          sound: 'default' as const,
        };
      }),
    );
  }

  /** Envía los mensajes a la Expo Push API en lotes de 100 (best-effort). */
  private async dispatch(messages: ExpoMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 100) {
      try {
        await fetch(PushService.EXPO_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(messages.slice(i, i + 100)),
        });
      } catch (e) {
        this.logger.warn(`Expo push send failed: ${(e as Error).message}`);
      }
    }
  }
}
