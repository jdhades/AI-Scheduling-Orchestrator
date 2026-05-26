import { Module, Global } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { IntegrationCredentialsService } from './integration-credentials.service';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * IntegrationsModule
 *
 * Global porque los services consumers (Twilio, Email, LLM) viven en
 * distintos módulos y necesitan acceso uniforme al service.
 *
 * Levanta EventEmitterModule (singleton) que los services consumers
 * usan para suscribirse al evento `integration.updated` y refrescar
 * su cliente dinámicamente.
 */
@Global()
@Module({
  imports: [
    SupabaseModule,
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      // Mantener el ordering para que el caller sepa que el reload
      // de los services downstream terminó antes de responder.
      verboseMemoryLeak: true,
    }),
  ],
  providers: [IntegrationCredentialsService],
  exports: [IntegrationCredentialsService],
})
export class IntegrationsModule {}
