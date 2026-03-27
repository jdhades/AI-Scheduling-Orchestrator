import { Module, Scope } from '@nestjs/common';
import { TenantContext } from './tenant.context';
import { TenantMiddleware } from './tenant.middleware';

/**
 * TenantModule
 *
 * Provee TenantContext con scope REQUEST para garantizar que cada
 * HTTP request tiene su propio tenant aislado en memoria.
 *
 * 💡 Scope.REQUEST es crítico: sin él, NestJS reutilizaría la misma
 *    instancia entre requests concurrentes, causando fuga de tenant data
 *    entre empresas — una vulnerabilidad de seguridad grave.
 *
 * Se importa en AppModule y otros módulos que necesiten TenantContext.
 */
@Module({
  providers: [
    {
      provide: TenantContext,
      scope: Scope.REQUEST,
      useClass: TenantContext,
    },
    TenantMiddleware,
  ],
  exports: [TenantContext],
})
export class TenantModule {}
