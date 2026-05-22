import { Controller, Get, Inject } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

export interface AdminNotificationItem {
  /** Unique id (idempotencia para el frontend). */
  id: string;
  /** Texto principal — humano, sin jerga técnica. */
  primary: string;
  /** Subtexto — empresa, fecha, etc. Opcional. */
  secondary?: string;
  /** ISO timestamp para ordenar + render relativo (RelativeTime). */
  when: string;
  /** A dónde llevar al hacer click. */
  href: string;
}

export interface AdminNotificationsResponse {
  openTickets: {
    count: number;
    items: AdminNotificationItem[];
  };
  trialsExpiringSoon: {
    count: number;
    items: AdminNotificationItem[];
  };
  pastDue: {
    count: number;
    items: AdminNotificationItem[];
  };
  failedJobs24h: {
    count: number;
    items: AdminNotificationItem[];
  };
}

/**
 * AdminNotificationsController — payload agregado para la campanita
 * del admin. Polling 30s desde el frontend; también recibe WS push
 * cuando un tenant crea un support ticket (canal admin-room).
 *
 * Cada sección devuelve count (para el badge) + items (max 5 más
 * recientes/críticos para el dropdown).
 */
@Controller('admin/notifications')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminNotificationsController {
  /** Cap de items por sección — el dropdown muestra 5 max, el contador
   * usa count real. */
  private static readonly PREVIEW_LIMIT = 5;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  async get(): Promise<AdminNotificationsResponse> {
    const [tickets, trials, pastDue, failed] = await Promise.all([
      this.openTickets(),
      this.trialsExpiringSoon(),
      this.pastDueSubscriptions(),
      this.failedJobs24h(),
    ]);
    return {
      openTickets: tickets,
      trialsExpiringSoon: trials,
      pastDue,
      failedJobs24h: failed,
    };
  }

  private async openTickets() {
    const { data, count } = await this.supabase
      .from('support_tickets')
      .select('id, title, severity, created_at, companies(name)', {
        count: 'exact',
      })
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(AdminNotificationsController.PREVIEW_LIMIT);

    const rows = (data ?? []) as Array<{
      id: string;
      title: string;
      severity: 'low' | 'medium' | 'high';
      created_at: string;
      companies: Array<{ name: string | null }> | null;
    }>;

    return {
      count: count ?? rows.length,
      items: rows.map<AdminNotificationItem>((r) => ({
        id: `ticket:${r.id}`,
        primary: r.title,
        secondary: r.companies?.[0]?.name ?? '—',
        when: r.created_at,
        href: '/admin/support-tickets',
      })),
    };
  }

  private async trialsExpiringSoon() {
    // Ventana: ahora → ahora + 3 días. Solo tenants en estado 'trialing'.
    const now = new Date();
    const threeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const { data, count } = await this.supabase
      .from('companies')
      .select('id, name, trial_ends_at', { count: 'exact' })
      .eq('subscription_status', 'trialing')
      .gte('trial_ends_at', now.toISOString())
      .lte('trial_ends_at', threeDays.toISOString())
      .order('trial_ends_at', { ascending: true })
      .limit(AdminNotificationsController.PREVIEW_LIMIT);

    const rows = (data ?? []) as Array<{
      id: string;
      name: string | null;
      trial_ends_at: string;
    }>;

    return {
      count: count ?? rows.length,
      items: rows.map<AdminNotificationItem>((r) => ({
        id: `trial:${r.id}`,
        primary: r.name ?? '—',
        secondary: `trial → ${r.trial_ends_at.slice(0, 10)}`,
        when: r.trial_ends_at,
        href: '/admin/companies',
      })),
    };
  }

  private async pastDueSubscriptions() {
    const { data, count } = await this.supabase
      .from('companies')
      .select('id, name, updated_at, current_period_end', { count: 'exact' })
      .eq('subscription_status', 'past_due')
      .order('updated_at', { ascending: false })
      .limit(AdminNotificationsController.PREVIEW_LIMIT);

    const rows = (data ?? []) as Array<{
      id: string;
      name: string | null;
      updated_at: string;
      current_period_end: string | null;
    }>;

    return {
      count: count ?? rows.length,
      items: rows.map<AdminNotificationItem>((r) => ({
        id: `pastdue:${r.id}`,
        primary: r.name ?? '—',
        secondary: r.current_period_end
          ? `period → ${r.current_period_end.slice(0, 10)}`
          : undefined,
        when: r.updated_at,
        href: '/admin/companies',
      })),
    };
  }

  private async failedJobs24h() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, count } = await this.supabase
      .from('schedule_generation_runs')
      .select('id, week_start, created_at, companies(name)', {
        count: 'exact',
      })
      .eq('status', 'failed')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(AdminNotificationsController.PREVIEW_LIMIT);

    const rows = (data ?? []) as Array<{
      id: string;
      week_start: string;
      created_at: string;
      companies: Array<{ name: string | null }> | null;
    }>;

    return {
      count: count ?? rows.length,
      items: rows.map<AdminNotificationItem>((r) => ({
        id: `failedjob:${r.id}`,
        primary: r.companies?.[0]?.name ?? '—',
        secondary: `week ${r.week_start}`,
        when: r.created_at,
        href: '/admin/jobs',
      })),
    };
  }
}
