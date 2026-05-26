import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { INotificationService } from '../../domain/services/notification.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Twilio = require('twilio');

/**
 * TwilioService — Adapter del puerto INotificationService
 *
 * Responsabilidad única: enviar mensajes WhatsApp vía Twilio.
 *
 * 💡 Clean Architecture:
 *    - Esta clase vive en infraestructura (sabe que Twilio existe).
 *    - Los handlers de aplicación solo conocen INotificationService.
 *    - Si mañana cambiamos a Meta Cloud API, solo cambia este archivo.
 *
 * 📋 Variables de entorno requeridas:
 *    TWILIO_ACCOUNT_SID   — Account SID desde Twilio Console
 *    TWILIO_AUTH_TOKEN    — Auth Token desde Twilio Console
 *    TWILIO_FROM_NUMBER   — Número WhatsApp habilitado (sandbox o producción)
 */
@Injectable()
export class TwilioService implements INotificationService {
  private readonly client: ReturnType<typeof Twilio> | null;
  private readonly fromNumber: string;
  private readonly enabled: boolean;
  private readonly logger = new Logger(TwilioService.name);

  constructor(private readonly config: ConfigService) {
    // Read-without-throw — staging puede correr sin Twilio configurado
    // (no probamos WhatsApp todavía). Si falta cualquiera de los 3
    // valores, el service queda en modo no-op: logea + skip, sin tirar.
    const accountSid = this.config.get<string>('twilio.accountSid') ?? '';
    const authToken = this.config.get<string>('twilio.authToken') ?? '';
    this.fromNumber = this.config.get<string>('twilio.fromNumber') ?? '';
    this.enabled = !!accountSid && !!authToken && !!this.fromNumber;

    if (this.enabled) {
      // Twilio CJS exports a callable function as the module default
      this.client = Twilio(accountSid, authToken);
    } else {
      this.client = null;
      this.logger.warn(
        'TwilioService disabled — TWILIO_{ACCOUNT_SID,AUTH_TOKEN,FROM_NUMBER} not configured. WhatsApp notifications will be no-ops.',
      );
    }
  }

  /**
   * Envía un mensaje WhatsApp al número dado.
   *
   * Prefijo "whatsapp:" requerido por la Twilio WhatsApp API.
   * Ejemplo: from = "whatsapp:+14155238886", to = "whatsapp:+34612345678"
   *
   * Si Twilio no está configurado, no-op (log + return). NO tira — un
   * fail silencioso es preferible a crashear handlers de eventos que
   * disparan notificaciones como side-effect.
   */
  async sendWhatsApp(to: string, body: string): Promise<void> {
    if (!this.enabled || !this.client) {
      this.logger.warn(
        `[noop] sendWhatsApp → ${to}: Twilio not configured. Message dropped (${body.slice(0, 60)}…)`,
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
}
