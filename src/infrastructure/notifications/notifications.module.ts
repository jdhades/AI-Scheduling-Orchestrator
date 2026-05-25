import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TwilioService } from './twilio.service';
import { EmailService } from './email.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';

/**
 * NotificationsModule
 *
 * Provee:
 *   - NOTIFICATION_SERVICE (Twilio) — para SMS/WhatsApp
 *   - EmailService — para mails transaccionales custom (invitaciones)
 *
 * Supabase Auth maneja signup-confirm + password-reset + email-change
 * por su cuenta vía Custom SMTP del Dashboard; acá solo cubrimos mails
 * que el backend dispara directo.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: NOTIFICATION_SERVICE,
      useClass: TwilioService,
    },
    EmailService,
  ],
  exports: [NOTIFICATION_SERVICE, EmailService],
})
export class NotificationsModule {}
