import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TrialGuard } from './guards/trial.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { CapabilityGuard } from './guards/capability.guard';
import { JwtValidatorService } from './services/jwt-validator.service';
import { ScopeService } from './services/scope.service';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * AuthModule — registra los guards globales en orden correcto:
 *
 *   SupabaseAuthGuard    →  identidad (auth)
 *   RolesGuard            →  autorización por rol (legacy, coexiste)
 *   TrialGuard            →  bloquea cuando trial expirado / canceled
 *   PlatformAdminGuard    →  @PlatformAdmin() para panel cross-tenant
 *   CapabilityGuard       →  @Requires('cap:X') — RBAC fine-grained
 *
 * APP_GUARD aplica TODOS los guards listados en orden.
 *
 * `ScopeService` se exporta para que controllers que necesiten validar
 * scope de un recurso lo inyecten (`assertDeptInScope(user, deptId)`).
 */
@Global()
@Module({
  imports: [SupabaseModule],
  providers: [
    JwtValidatorService,
    ScopeService,
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TrialGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PlatformAdminGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CapabilityGuard,
    },
  ],
  exports: [JwtValidatorService, ScopeService],
})
export class AuthModule {}
