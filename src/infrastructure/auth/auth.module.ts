import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TrialGuard } from './guards/trial.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { JwtValidatorService } from './services/jwt-validator.service';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * AuthModule — registra los guards globales en orden correcto:
 *
 *   SupabaseAuthGuard  →  identidad (auth)
 *   RolesGuard          →  autorización por rol
 *   TrialGuard          →  bloquea cuando companies.subscription_status
 *                         ='trialing' AND trial_ends_at < now(), o
 *                         ='canceled'. Endpoints con @AllowExpiredTrial
 *                         lo saltean (/auth/me, /onboarding/*, /billing/*)
 *
 * APP_GUARD aplica TODOS los guards listados en orden.
 *
 * Marcado `@Global()` para que `JwtValidatorService` y los decoradores
 * sean importables desde cualquier módulo sin re-declarar el import.
 */
@Global()
@Module({
  imports: [SupabaseModule],
  providers: [
    JwtValidatorService,
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
  ],
  exports: [JwtValidatorService],
})
export class AuthModule {}
