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
    private readonly client: ReturnType<typeof Twilio>;
    private readonly fromNumber: string;
    private readonly logger = new Logger(TwilioService.name);

    constructor(private readonly config: ConfigService) {
        const accountSid = this.config.getOrThrow<string>('twilio.accountSid');
        const authToken = this.config.getOrThrow<string>('twilio.authToken');
        this.fromNumber = this.config.getOrThrow<string>('twilio.fromNumber');

        // Twilio CJS exports a callable function as the module default
        this.client = Twilio(accountSid, authToken);
    }

    /**
     * Envía un mensaje WhatsApp al número dado.
     *
     * Prefijo "whatsapp:" requerido por la Twilio WhatsApp API.
     * Ejemplo: from = "whatsapp:+14155238886", to = "whatsapp:+34612345678"
     */
    async sendWhatsApp(to: string, body: string): Promise<void> {
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
