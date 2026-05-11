import { Global, Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LLMUsageTracker } from './llm-usage-tracker.service';
import { LLMUsageLogger } from './llm-usage-logger.service';

/**
 * ObservabilityModule — Global, instancia única.
 *
 * Por qué `@Global()`: tanto `LLMUsageTracker` como `LLMUsageLogger`
 * usan `AsyncLocalStorage` — el contexto solo se propaga cuando hay
 * UNA sola instancia compartida. Si distintos módulos crean su propia,
 * el `withContext()` del worker no llega al `record()` del LLM service.
 *
 * Cualquier módulo que inyecte estos services lo recibe sin necesidad
 * de imports explícitos. Así evitamos: (a) que cada módulo declare el
 * provider, (b) que circular imports rompan la app.
 */
@Global()
@Module({
  imports: [SupabaseModule],
  providers: [LLMUsageTracker, LLMUsageLogger],
  exports: [LLMUsageTracker, LLMUsageLogger],
})
export class ObservabilityModule {}
