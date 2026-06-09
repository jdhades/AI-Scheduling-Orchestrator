import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Sends push notifications via the Expo Push API to the employees' registered
 * devices. Best-effort + batched (Expo caps 100 messages/request). v1 sends
 * inline fire-and-forget; can move behind pg-boss for retries/throughput later.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private static readonly EXPO_URL = 'https://exp.host/--/api/v2/push/send';

  constructor(@Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient) {}

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

    const messages = tokens.map((to) => ({
      to,
      title: n.title,
      body: n.body,
      data: n.data ?? {},
      sound: 'default' as const,
    }));
    for (let i = 0; i < messages.length; i += 100) {
      try {
        await fetch(PushService.EXPO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(messages.slice(i, i + 100)),
        });
      } catch (e) {
        this.logger.warn(`Expo push send failed: ${(e as Error).message}`);
      }
    }
  }
}
