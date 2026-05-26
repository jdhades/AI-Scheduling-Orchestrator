import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import type { INotificationService } from '../../domain/services/notification.service';
import {
  IntegrationCredentialsService,
  INTEGRATION_UPDATED_EVENT,
  type IntegrationUpdatedPayload,
} from '../integrations/integration-credentials.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Twilio = require('twilio');

/**
 * TwilioService — Adapter del puerto INotificationService
 *
 * Lee credenciales desde `integration_credentials` (Vault) vía
 * IntegrationCredentialsService. Fallback a env vars del .env si la
 * row de DB no existe (compat con bootstrap inicial pre-migración).
 *
 * Si `enabled=false` o credenciales faltantes → no-op (log + skip).
 * No tira. Re-inicializa el cliente cuando recibe el evento
 * `integration.updated` para el provider 'twilio' del env activo.
 */
@Injectable()
export class TwilioService implements INotificationService, OnModuleInit {
  private client: ReturnType<typeof Twilio> | null = null;
  private fromNumber = '';
  private enabled = false;
  private readonly logger = new Logger(TwilioService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly integrations: IntegrationCredentialsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /**
   * Re-leer config desde DB (Vault). Si no existe en DB todavía, fallback
   * a env vars — pero NO setear enabled=true automáticamente. El admin
   * debe explícitamente activar desde el panel.
   */
  async reload(): Promise<void> {
    const cfg = await this.integrations.get('twilio');
    if (cfg && cfg.enabled) {
      const creds = cfg.credentials as {
        accountSid?: string;
        authToken?: string;
        fromNumber?: string;
      };
      const sid = creds.accountSid ?? '';
      const token = creds.authToken ?? '';
      this.fromNumber = creds.fromNumber ?? '';
      if (sid && token && this.fromNumber) {
        this.client = Twilio(sid, token);
        this.enabled = true;
        this.logger.log(
          `TwilioService enabled from integration_credentials (env=${this.integrations.activeEnv}).`,
        );
        return;
      }
    }

    // Fallback: env vars (bootstrap / compat). Solo si las 3 vars
    // están seteadas — sin la cred completa NO arrancamos el cliente.
    const sid = this.config.get<string>('twilio.accountSid') ?? '';
    const token = this.config.get<string>('twilio.authToken') ?? '';
    this.fromNumber = this.config.get<string>('twilio.fromNumber') ?? '';
    if (sid && token && this.fromNumber) {
      this.client = Twilio(sid, token);
      this.enabled = true;
      this.logger.log('TwilioService enabled from .env (legacy fallback).');
      return;
    }

    this.client = null;
    this.enabled = false;
    this.logger.warn(
      'TwilioService disabled — no credentials in integration_credentials nor .env. WhatsApp notifications are no-ops.',
    );
  }

  /**
   * Listener — el admin actualizó la integración Twilio. Re-init.
   */
  @OnEvent(INTEGRATION_UPDATED_EVENT)
  async onIntegrationUpdated(
    payload: IntegrationUpdatedPayload,
  ): Promise<void> {
    if (payload.provider !== 'twilio') return;
    if (payload.environment !== this.integrations.activeEnv) return;
    this.logger.log('TwilioService: integration updated — reloading client.');
    await this.reload();
  }

  /**
   * Envía un mensaje WhatsApp al número dado. No-op si está desactivado.
   */
  async sendWhatsApp(to: string, body: string): Promise<void> {
    if (!this.enabled || !this.client) {
      this.logger.warn(
        `[noop] sendWhatsApp → ${to}: Twilio not configured/enabled. Message dropped (${body.slice(0, 60)}…)`,
      );
      return;
    }

    const from = `whatsapp:${this.fromNumber}`;
    const toFormatted = `whatsapp:${to}`;

    try {
      const message = await this.client.messages.create({
        from,
        to: toFormatted,
        body,
      });
      this.logger.log(
        `WhatsApp sent → ${to} | SID: ${message.sid} | Status: ${message.status}`,
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`TwilioService.sendWhatsApp failed → ${to}: ${msg}`);
      throw new Error(`Notification failed: ${msg}`);
    }
  }

  /**
   * Dry-run para el botón "Test connection" del panel admin.
   * Intenta validar las credenciales sin mandar mensaje real.
   */
  async testConnection(creds: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = Twilio(creds.accountSid, creds.authToken);
      await client.api.v2010.accounts(creds.accountSid).fetch();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
