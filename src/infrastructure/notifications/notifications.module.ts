import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TwilioService } from './twilio.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';

/**
 * NotificationsModule
 *
 * Provee el token NOTIFICATION_SERVICE con la implementación TwilioService.
 * Exportarlo permite que ApplicationModule lo use en los event handlers.
 *
 * 💡 Para tests, este módulo se reemplaza por un mock del token
 *    sin necesidad de modificar los handlers.
 */
@Module({
    imports: [ConfigModule],
    providers: [
        {
            provide: NOTIFICATION_SERVICE,
            useClass: TwilioService,
        },
    ],
    exports: [NOTIFICATION_SERVICE],
})
export class NotificationsModule { }
