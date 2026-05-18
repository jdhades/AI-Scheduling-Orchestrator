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
import { SupabaseCompanyPolicyRepository } from './supabase-company-policy.repository';
import { SupabaseWhatsappPendingClarificationRepository } from './supabase-whatsapp-pending-clarification.repository';
import { WhatsappPolicyPermissionService } from '../../domain/services/whatsapp-policy-permission.service';
import { IncidentRepository } from '../database/incident.repository';
import { SupabaseShiftSwapRequestRepository } from './supabase-shift-swap-request.repository';
import { SupabaseAbsenceReportRepository } from './supabase-absence-report.repository';
import { SupabaseDayOffRequestRepository } from './supabase-day-off-request.repository';
import { SupabaseShiftAssignmentBreakRepository } from './supabase-shift-assignment-break.repository';
import { SupabaseShiftTemplateBreakRepository } from './supabase-shift-template-break.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_MEMBERSHIP_REPOSITORY } from '../../domain/repositories/shift-membership.repository';
import { SHIFT_ASSIGNMENT_BREAK_REPOSITORY } from '../../domain/repositories/shift-assignment-break.repository';
import { SHIFT_TEMPLATE_BREAK_REPOSITORY } from '../../domain/repositories/shift-template-break.repository';
import { COMPANY_SKILL_REPOSITORY } from '../../domain/repositories/company-skill.repository';
import { COMPANY_POLICY_REPOSITORY } from '../../domain/repositories/company-policy.repository';
import { WHATSAPP_PENDING_CLARIFICATION_REPOSITORY } from '../../domain/repositories/whatsapp-pending-clarification.repository';
import { SHIFT_SWAP_REQUEST_REPOSITORY } from '../../domain/repositories/shift-swap-request.repository';
import { ABSENCE_REPORT_REPOSITORY } from '../../domain/repositories/absence-report.repository';
import { DAY_OFF_REQUEST_REPOSITORY } from '../../domain/repositories/day-off-request.repository';
import { ConfigService } from '@nestjs/config';
import { QwenEmbeddingService } from '../services/qwen-embedding.service';
import { GeminiEmbeddingService } from '../services/gemini-embedding.service';
import { QwenLLMService } from '../services/qwen-llm.service';
import { GeminiLLMService } from '../services/gemini-llm.service';
import { LocalLLMService } from '../services/local-llm.service';
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
    // LLMUsageTracker + LLMUsageLogger viven en ObservabilityModule
    // (@Global) — único shared singleton para que el ALS funcione.
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
    {
      provide: COMPANY_POLICY_REPOSITORY,
      useClass: SupabaseCompanyPolicyRepository,
    },
    // WhatsApp suggestion-loop (commit 9): storage + permission service.
    // El MessageRouter integration queda como follow-up.
    {
      provide: WHATSAPP_PENDING_CLARIFICATION_REPOSITORY,
      useClass: SupabaseWhatsappPendingClarificationRepository,
    },
    WhatsappPolicyPermissionService,
    // Incident: repositorio Supabase-backed (reemplaza el stub in-memory)
    IncidentRepository,
    {
      provide: SHIFT_SWAP_REQUEST_REPOSITORY,
      useClass: SupabaseShiftSwapRequestRepository,
    },
    {
      provide: ABSENCE_REPORT_REPOSITORY,
      useClass: SupabaseAbsenceReportRepository,
    },
    {
      provide: DAY_OFF_REQUEST_REPOSITORY,
      useClass: SupabaseDayOffRequestRepository,
    },
    {
      provide: SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
      useClass: SupabaseShiftAssignmentBreakRepository,
    },
    {
      provide: SHIFT_TEMPLATE_BREAK_REPOSITORY,
      useClass: SupabaseShiftTemplateBreakRepository,
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
    COMPANY_POLICY_REPOSITORY,
    WHATSAPP_PENDING_CLARIFICATION_REPOSITORY,
    WhatsappPolicyPermissionService,
    IncidentRepository,
    SHIFT_SWAP_REQUEST_REPOSITORY,
    ABSENCE_REPORT_REPOSITORY,
    DAY_OFF_REQUEST_REPOSITORY,
    SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
    SHIFT_TEMPLATE_BREAK_REPOSITORY,
  ],
})
export class RepositoriesModule {}
