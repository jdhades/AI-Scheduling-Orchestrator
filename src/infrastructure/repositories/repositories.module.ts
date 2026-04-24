import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../supabase/supabase.module';
import { SupabaseEmployeeRepository } from './supabase-employee.repository';
import { SupabaseHandshakeRepository } from './supabase-handshake.repository';
import { SupabaseShiftRepository } from './supabase-shift.repository';
import { SupabaseFairnessHistoryRepository } from './supabase-fairness-history.repository';
import { SupabaseSemanticRuleRepository } from './supabase-semantic-rule.repository';
import { SupabaseShiftTemplateRepository } from './supabase-shift-template.repository';
import { SupabaseShiftAssignmentRepository } from './supabase-shift-assignment.repository';
import { SupabaseShiftMembershipRepository } from './supabase-shift-membership.repository';
import { SupabaseCompanySkillRepository } from './supabase-company-skill.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_MEMBERSHIP_REPOSITORY } from '../../domain/repositories/shift-membership.repository';
import { COMPANY_SKILL_REPOSITORY } from '../../domain/repositories/company-skill.repository';
import { ConfigService } from '@nestjs/config';
import { QwenEmbeddingService } from '../services/qwen-embedding.service';
import { GeminiEmbeddingService } from '../services/gemini-embedding.service';
import { QwenLLMService } from '../services/qwen-llm.service';
import { GeminiLLMService } from '../services/gemini-llm.service';
import { LocalLLMService } from '../services/local-llm.service';
import { LLMUsageTracker } from '../observability/llm-usage-tracker.service';
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
    // Instanciamos ambas implementaciones
    QwenEmbeddingService,
    GeminiEmbeddingService,
    QwenLLMService,
    GeminiLLMService,
    LocalLLMService,
    LLMUsageTracker,
    {
      provide: EMBEDDING_SERVICE_TOKEN,
      inject: [ConfigService, QwenEmbeddingService, GeminiEmbeddingService],
      useFactory: (config: ConfigService, qwen: QwenEmbeddingService, gemini: GeminiEmbeddingService) => {
        return config.get('ai.activeProvider') === 'gemini' ? gemini : qwen;
      },
    },
    // Prompt Orchestrator — LLM Service
    {
      provide: LLM_SERVICE,
      inject: [ConfigService, QwenLLMService, GeminiLLMService, LocalLLMService],
      useFactory: (
        config: ConfigService,
        qwen: QwenLLMService,
        gemini: GeminiLLMService,
        local: LocalLLMService,
      ) => {
        const provider = config.get('ai.activeProvider');
        if (provider === 'gemini') return gemini;
        if (provider === 'local') return local;
        return qwen;
      },
    },
    // Phase 2 — Shift Templates
    {
      provide: 'SHIFT_TEMPLATE_REPOSITORY',
      useClass: SupabaseShiftTemplateRepository,
    },
    // Rework — ShiftAssignment + ShiftMembership (modelo nuevo)
    {
      provide: SHIFT_ASSIGNMENT_REPOSITORY,
      useClass: SupabaseShiftAssignmentRepository,
    },
    {
      provide: SHIFT_MEMBERSHIP_REPOSITORY,
      useClass: SupabaseShiftMembershipRepository,
    },
    {
      provide: COMPANY_SKILL_REPOSITORY,
      useClass: SupabaseCompanySkillRepository,
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
    'SHIFT_TEMPLATE_REPOSITORY',
    SHIFT_ASSIGNMENT_REPOSITORY,
    SHIFT_MEMBERSHIP_REPOSITORY,
    COMPANY_SKILL_REPOSITORY,
    LLMUsageTracker,
  ],
})
export class RepositoriesModule {}
