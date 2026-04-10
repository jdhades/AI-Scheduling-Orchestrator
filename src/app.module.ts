import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { I18nModule, AcceptLanguageResolver } from 'nestjs-i18n';
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
    ApplicationModule,
    TenantModule,
    RepositoriesModule,
    InterfacesModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
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
      )
      .forRoutes('*');
  }
}
