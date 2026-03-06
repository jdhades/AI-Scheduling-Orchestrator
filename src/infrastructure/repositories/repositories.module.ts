import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../supabase/supabase.module';
import { SupabaseEmployeeRepository } from './supabase-employee.repository';
import { SupabaseHandshakeRepository } from './supabase-handshake.repository';
import { SupabaseShiftRepository } from './supabase-shift.repository';
import { SupabaseFairnessHistoryRepository } from './supabase-fairness-history.repository';
import { SupabaseSemanticRuleRepository } from './supabase-semantic-rule.repository';
import { GeminiEmbeddingService } from '../services/gemini-embedding.service';
import { GeminiLLMService } from '../services/gemini-llm.service';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { HANDSHAKE_REPOSITORY } from '../../domain/repositories/handshake.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import { FAIRNESS_HISTORY_REPOSITORY } from '../../domain/repositories/fairness-history.repository';
import { SEMANTIC_RULE_REPOSITORY_TOKEN } from '../../domain/repositories/semantic-rule.repository.interface';
import { EMBEDDING_SERVICE_TOKEN } from '../../domain/services/embedding.service.interface';
import { LLM_SERVICE } from '../../domain/services/llm.service.interface';
import { TenantModule } from '../tenant/tenant.module';

/**
 * RepositoriesModule
 *
 * Registra las implementaciones concretas de cada repositorio
 * bajo sus tokens de inyección (EMPLOYEE_REPOSITORY, HANDSHAKE_REPOSITORY).
 *
 * 💡 Token = interfaz. Cualquier módulo que inyecte EMPLOYEE_REPOSITORY
 *    obtiene SupabaseEmployeeRepository sin saber que es Supabase.
 *    En tests se puede proveer un mock con el mismo token.
 */
@Module({
    imports: [SupabaseModule, TenantModule, ConfigModule],
    providers: [
        {
            provide: EMPLOYEE_REPOSITORY,
            useClass: SupabaseEmployeeRepository,
        },
        {
            provide: HANDSHAKE_REPOSITORY,
            useClass: SupabaseHandshakeRepository,
        },
        {
            provide: SHIFT_REPOSITORY,
            useClass: SupabaseShiftRepository,
        },
        {
            provide: FAIRNESS_HISTORY_REPOSITORY,
            useClass: SupabaseFairnessHistoryRepository,
        },
        // Escenario 3 — Semantic Rule Engine
        {
            provide: SEMANTIC_RULE_REPOSITORY_TOKEN,
            useClass: SupabaseSemanticRuleRepository,
        },
        {
            provide: EMBEDDING_SERVICE_TOKEN,
            useClass: GeminiEmbeddingService,
        },
        // Prompt Orchestrator — LLM Service
        {
            provide: LLM_SERVICE,
            useClass: GeminiLLMService,
        },
    ],
    exports: [
        EMPLOYEE_REPOSITORY,
        HANDSHAKE_REPOSITORY,
        SHIFT_REPOSITORY,
        FAIRNESS_HISTORY_REPOSITORY,
        SEMANTIC_RULE_REPOSITORY_TOKEN,
        EMBEDDING_SERVICE_TOKEN,
        LLM_SERVICE,
    ],
})
export class RepositoriesModule { }
