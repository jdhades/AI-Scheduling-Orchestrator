import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TwilioService } from './twilio.service';
import { EmailService } from './email.service';
import { PushService } from './push.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import { SupabaseModule } from '../supabase/supabase.module';

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
  imports: [ConfigModule, SupabaseModule],
  providers: [
    // TwilioService como provider directo + aliased también como
    // NOTIFICATION_SERVICE. El alias mantiene el contract con domain
    // handlers que solo conocen la interface; el provider directo
    // permite que AdminIntegrationsController inyecte la clase
    // concreta para llamar testConnection() / reload().
    TwilioService,
    {
      provide: NOTIFICATION_SERVICE,
      useExisting: TwilioService,
    },
    EmailService,
    // Push (Expo) — disponible para application (schedule/incidents) e
    // interfaces (chat/approvals) sin duplicar el provider.
    PushService,
  ],
  exports: [NOTIFICATION_SERVICE, TwilioService, EmailService, PushService],
})
export class NotificationsModule {}
