import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { JwtValidatorService } from './services/jwt-validator.service';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * AuthModule — registra los dos guards globales en orden correcto:
 *
 *   SupabaseAuthGuard  →  identidad (auth)
 *   RolesGuard          →  autorización (authz, requiere SupabaseAuthGuard arriba)
 *
 * APP_GUARD aplica TODOS los guards listados en orden. Acá Supabase
 * primero (popula req.auth) y Roles después (lee req.auth.role).
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
  ],
  exports: [JwtValidatorService],
})
export class AuthModule {}
