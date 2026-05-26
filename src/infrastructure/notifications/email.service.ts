import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Resend } from 'resend';
import {
  IntegrationCredentialsService,
  INTEGRATION_UPDATED_EVENT,
  type IntegrationUpdatedPayload,
} from '../integrations/integration-credentials.service';

/**
 * EmailService — wrapper transactional sobre Resend.
 *
 * Usado para:
 *   - Invitaciones a managers/employees (POST /auth/invitations)
 *
 * Supabase Auth maneja por su cuenta los mails de signup-confirm + password-
 * reset + email-change (Custom SMTP del Dashboard apuntando a Resend con
 * otra API key). Acá solo mandamos los mails que el backend dispara
 * directo (custom template + link a nuestro accept page).
 *
 * Config:
 *   RESEND_API_KEY        = re_xxx
 *   EMAIL_FROM            = "AI Scheduling <noreply@islabroadcast.com>"
 *   FRONTEND_URL          = https://app.islabroadcast.com (para armar links)
 *
 * Si RESEND_API_KEY no está seteado, el service queda en modo "log only" —
 * loguea el mail que mandaría pero no llama al provider. Útil para dev
 * local sin tener que arrancar Resend.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private from = '';
  private frontendUrl = '';

  constructor(
    private readonly config: ConfigService,
    private readonly integrations: IntegrationCredentialsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /**
   * Re-leer config desde DB (Vault). Fallback a .env si la DB no
   * tiene row todavía (compat bootstrap).
   */
  async reload(): Promise<void> {
    // FRONTEND_URL no es secreto — siempre de .env (rara vez cambia y
    // se necesita para armar links incluso si Resend está apagado).
    this.frontendUrl =
      this.config.get<string>('FRONTEND_URL') ??
      'https://app.islabroadcast.com';

    const cfg = await this.integrations.get('resend');
    if (cfg && cfg.enabled) {
      const creds = cfg.credentials as { apiKey?: string; from?: string };
      const apiKey = creds.apiKey ?? '';
      this.from =
        creds.from ?? 'AI Scheduling <noreply@islabroadcast.com>';
      if (apiKey) {
        this.resend = new Resend(apiKey);
        this.logger.log(
          `EmailService enabled from integration_credentials (env=${this.integrations.activeEnv}, from=${this.from})`,
        );
        return;
      }
    }

    // Fallback .env
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.from =
      this.config.get<string>('EMAIL_FROM') ??
      'AI Scheduling <noreply@islabroadcast.com>';
    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log(`EmailService enabled from .env (from=${this.from})`);
      return;
    }

    this.resend = null;
    this.logger.warn(
      'RESEND_API_KEY not set — EmailService en modo log-only. Los mails NO se envían realmente.',
    );
  }

  /**
   * Listener — el admin actualizó la integración Resend. Re-init.
   */
  @OnEvent(INTEGRATION_UPDATED_EVENT)
  async onIntegrationUpdated(payload: IntegrationUpdatedPayload): Promise<void> {
    if (payload.provider !== 'resend') return;
    if (payload.environment !== this.integrations.activeEnv) return;
    this.logger.log('EmailService: integration updated — reloading client.');
    await this.reload();
  }

  /**
   * Dry-run para el botón "Test connection" del panel admin.
   * Manda un mail al sender mismo (Resend permite eso siempre).
   */
  async testConnection(creds: {
    apiKey: string;
    from?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = new Resend(creds.apiKey);
      const from = creds.from ?? 'onboarding@resend.dev';
      // Extraer el email del formato "Name <email@x>" si vino así.
      const m = from.match(/<([^>]+)>/);
      const to = m ? m[1] : from;
      const { data, error } = await client.emails.send({
        from,
        to,
        subject: 'AI Scheduling — test connection',
        text: 'This is an automated test. You can ignore this email.',
      });
      if (error) return { ok: false, error: error.message };
      if (!data?.id) return { ok: false, error: 'No id returned by Resend' };
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Manda el mail de invitación a un manager/employee.
   * El link apunta a `${FRONTEND_URL}/accept?token=...` — la AcceptInvitationPage
   * del frontend toma el token y dispara el POST /auth/invitations/:token/accept.
   */
  async sendInvitation(params: {
    to: string;
    token: string;
    companyName: string;
    inviterName: string;
    role: 'manager' | 'employee';
  }): Promise<void> {
    const acceptUrl = `${this.frontendUrl}/accept?token=${params.token}`;
    const roleLabel = params.role === 'manager' ? 'Manager' : 'Employee';

    const html = `
<!doctype html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; color: #111;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">You've been invited to ${escapeHtml(params.companyName)}</h1>
  <p style="font-size: 15px; line-height: 1.5;">
    ${escapeHtml(params.inviterName)} invited you to join <strong>${escapeHtml(params.companyName)}</strong> as a <strong>${roleLabel}</strong> on AI Scheduling.
  </p>
  <p style="margin: 32px 0;">
    <a href="${acceptUrl}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Accept invitation
    </a>
  </p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">
    If the button doesn't work, copy and paste this link into your browser:<br/>
    <a href="${acceptUrl}" style="color: #4f46e5; word-break: break-all;">${acceptUrl}</a>
  </p>
  <p style="font-size: 12px; color: #999; margin-top: 32px;">
    The invitation expires in 7 days. If you weren't expecting this email, you can safely ignore it.
  </p>
</body>
</html>`.trim();

    const text =
      `${params.inviterName} invited you to join ${params.companyName} as a ${roleLabel} on AI Scheduling.\n\n` +
      `Accept the invitation here: ${acceptUrl}\n\n` +
      `The link expires in 7 days.`;

    if (!this.resend) {
      this.logger.log(
        `[LOG-ONLY] Invitation to ${params.to} → ${acceptUrl}`,
      );
      return;
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: params.to,
        subject: `You've been invited to ${params.companyName}`,
        html,
        text,
      });
      if (error) {
        this.logger.error(
          `Resend error sending invitation to ${params.to}: ${error.message}`,
        );
        throw new Error(error.message);
      }
      this.logger.log(
        `Invitation sent to ${params.to} (resend id=${data?.id ?? 'unknown'})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to send invitation to ${params.to}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
