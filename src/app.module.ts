import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { I18nModule, AcceptLanguageResolver } from 'nestjs-i18n';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './infrastructure/config/config.module';
import { ApplicationModule } from './application/application.module';
import { TenantModule } from './infrastructure/tenant/tenant.module';
import { AuthModule } from './infrastructure/auth/auth.module';
import { TenantMiddleware } from './infrastructure/tenant/tenant.middleware';
import { RepositoriesModule } from './infrastructure/repositories/repositories.module';
import { InterfacesModule } from './interfaces/interfaces.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { StripeModule } from './infrastructure/stripe/stripe.module';

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: 'es',
      loaderOptions: {
        path: process.env.NODE_ENV === 'production' 
          ? path.join(__dirname, 'i18n') 
          : path.join(process.cwd(), 'src', 'i18n'),
        watch: true,
      },
      resolvers: [AcceptLanguageResolver],
    }),
    AppConfigModule,
    ObservabilityModule,
    // Rate limiting global. Tiers via @SkipThrottle/@Throttle en
    // endpoints específicos (login, schedule.generate, LLM-heavy).
    // Default: 60 req/min por IP — protege contra abuse básico sin
    // estorbar uso normal del manager.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    QueueModule,
    ApplicationModule,
    TenantModule,
    RepositoriesModule,
    InterfacesModule,
    AuthModule,
    StripeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Rate limiter global. Corre antes que los APP_GUARD de auth/roles
    // (NestJS ejecuta APP_GUARDs en orden de registración) — un cliente
    // que floodee el server gasta 0 ciclos de validación de JWT.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Aplicar TenantMiddleware a todas las rutas excepto health/auth/root
    consumer
      .apply(TenantMiddleware)
      .exclude(
        '/',
        '/health',
        '/auth/(.*)',
        '/webhooks/whatsapp',
        '/webhooks/twilio',
        // Stripe webhook: viene sin X-Company-Id ni JWT, autenticación
        // es la firma `stripe-signature` validada en el controller.
        '/webhooks/stripe',
      )
      .forRoutes('*');
  }
}
