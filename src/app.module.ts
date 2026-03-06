import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './infrastructure/config/config.module';
import { ApplicationModule } from './application/application.module';
import { TenantModule } from './infrastructure/tenant/tenant.module';
import { TenantMiddleware } from './infrastructure/tenant/tenant.middleware';
import { RepositoriesModule } from './infrastructure/repositories/repositories.module';
import { InterfacesModule } from './interfaces/interfaces.module';

@Module({
  imports: [AppConfigModule, ApplicationModule, TenantModule, RepositoriesModule, InterfacesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Aplicar TenantMiddleware a todas las rutas excepto health/auth/root
    consumer
      .apply(TenantMiddleware)
      .exclude('/', '/health', '/auth/(.*)')
      .forRoutes('*');
  }
}
