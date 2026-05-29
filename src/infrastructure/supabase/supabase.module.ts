import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

/**
 * SupabaseModule
 *
 * Provee el cliente de Supabase bajo el token 'SUPABASE_CLIENT'.
 * Usa ConfigService para leer las variables de entorno de forma segura
 * (12-Factor App) en lugar de acceder directamente a process.env.
 *
 * 💡 Este módulo es global implícitamente al ser importado por
 *    RepositoriesModule, que a su vez lo importa AppModule.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'SUPABASE_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient(
          config.getOrThrow<string>('SUPABASE_URL'),
          config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
          {
            // Backend usa service_role estático: no hay flujo de
            // session refresh. Sin estas flags, supabase-js intenta
            // mantener una "session" inexistente y agrega headers que
            // hacen fallar funciones SECURITY DEFINER con
            // "JWT issued at future" (PostgREST dispara check pgjwt
            // sobre el JWT auto-generado por el cliente).
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false,
            },
          },
        ),
    },
    // Anon client — para endpoints públicos que necesitan respetar el
    // flow nativo de auth (signUp con email verification, etc.).
    // SERVICE_ROLE bypasea RLS y skipea verificación — NO usarlo desde
    // un endpoint público porque permitiría side-effects no controlados.
    {
      provide: 'SUPABASE_ANON_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient(
          config.getOrThrow<string>('SUPABASE_URL'),
          config.getOrThrow<string>('SUPABASE_ANON_KEY'),
          {
            // Mismo razonamiento que SUPABASE_CLIENT — el anon client
            // del backend se usa para auth flows controlados
            // (signUp/signIn con email), nunca para mantener sesión.
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false,
            },
          },
        ),
    },
  ],
  exports: ['SUPABASE_CLIENT', 'SUPABASE_ANON_CLIENT'],
})
export class SupabaseModule {}
