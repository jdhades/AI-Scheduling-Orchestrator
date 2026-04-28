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
        ),
    },
  ],
  exports: ['SUPABASE_CLIENT'],
})
export class SupabaseModule {}
