import { Module } from '@nestjs/common';
import { EmployeeController } from './controllers/employee.controller';
import { HandshakeController } from './controllers/handshake.controller';
import { ScheduleController } from './controllers/schedule.controller';
import { RuleController } from './controllers/rule.controller';
import { WhatsAppController } from './controllers/whatsapp.controller';
import { ShiftTemplatesController } from './controllers/shift-templates.controller';
import { ShiftMembershipsController } from './controllers/shift-memberships.controller';
import { CompanySkillsController } from './controllers/company-skills.controller';
import { CompanyPoliciesController } from './controllers/company-policies.controller';
import { WorkingTimePolicyController } from './controllers/working-time-policy.controller';
import { FairnessHistoryController } from './controllers/fairness-history.controller';
import { IncidentsController } from './controllers/incidents.controller';
import { ShiftSwapRequestsController } from './controllers/shift-swap-requests.controller';
import { AbsenceReportsController } from './controllers/absence-reports.controller';
import { DayOffRequestsController } from './controllers/day-off-requests.controller';
import { ShiftPreferencesController } from './controllers/shift-preferences.controller';
import { ScopeTargetsController } from './controllers/scope-targets.controller';
import { DepartmentsController } from './controllers/departments.controller';
import { JobsController } from './controllers/jobs.controller';
import { ShiftAssignmentsController } from './controllers/shift-assignments.controller';
import { ShiftBreaksController } from './controllers/shift-breaks.controller';
import { TasksController } from './controllers/tasks.controller';
import { EntityHistoryController } from './controllers/entity-history.controller';
import { ScheduleGenerationRunsController } from './controllers/schedule-generation-runs.controller';
import { LLMUsageController } from './controllers/llm-usage.controller';
import { AuthController } from './controllers/auth.controller';
import { AuditController } from './controllers/audit.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import { AdminController } from './controllers/admin.controller';
import { StripeWebhookController } from './controllers/stripe-webhook.controller';
import { BillingController } from './controllers/billing.controller';
import { BranchesController } from './controllers/branches.controller';
import { SettingsController } from './controllers/settings.controller';
import { CoverageController } from './controllers/coverage.controller';
import { OperationalKpisController } from './controllers/operational-kpis.controller';
import { OperationalBreakdownController } from './controllers/operational-breakdown.controller';
import { AdminPromptHistoryController } from './controllers/admin-prompt-history.controller';
import { AdminAuditController } from './controllers/admin-audit.controller';
import { AdminJobsController } from './controllers/admin-jobs.controller';
import { AdminLLMUsageController } from './controllers/admin-llm-usage.controller';
import { AdminDashboardController } from './controllers/admin-dashboard.controller';
import { AdminTenantOpsController } from './controllers/admin-tenant-ops.controller';
import { AdminLLMBudgetsController } from './controllers/admin-llm-budgets.controller';
import { AdminTenantFeaturesController } from './controllers/admin-tenant-features.controller';
import { AdminCompanyLlmAllowlistController } from './controllers/admin-company-llm-allowlist.controller';
import { AdminLLMModelsController } from './controllers/admin-llm-models.controller';
import { AdminPolicyInterpretersController } from './controllers/admin-policy-interpreters.controller';
import { AdminPlansController } from './controllers/admin-plans.controller';
import { AdminImpersonateController } from './controllers/admin-impersonate.controller';
import { AdminPlatformUsersController } from './controllers/admin-platform-users.controller';
import { AdminIntegrationsController } from './controllers/admin-integrations.controller';
import { SupportTicketsController } from './controllers/support-tickets.controller';
import { AdminSupportTicketsController } from './controllers/admin-support-tickets.controller';
import { AdminNotificationsController } from './controllers/admin-notifications.controller';
import { LLMModelBudgetsController } from './controllers/llm-model-budgets.controller';
import { ApplicationModule } from '../application/application.module';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';
import { SupabaseModule } from '../infrastructure/supabase/supabase.module';
import { WebsocketModule } from '../infrastructure/websocket/websocket.module';
import { RedisModule } from '../infrastructure/redis/redis.module';
import { NotificationsModule } from '../infrastructure/notifications/notifications.module';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './controllers/health.controller';
import { ImportsController } from './controllers/imports.controller';
import { ImportValidatorService } from '../application/imports/import-validator.service';
import { ImportPreviewBuilderService } from '../application/imports/import-preview-builder.service';
import { ImportCommitterService } from '../application/imports/import-committer.service';

import { WhatsAppIncidentController } from './controllers/whatsapp-incident.controller';

@Module({
  imports: [
    ApplicationModule,
    RepositoriesModule,
    SupabaseModule,
    WebsocketModule,
    // Terminus + Redis para el HealthController. DB se chequea con un
    // pool pg propio dentro del controller (pg-boss `.db` no es API
    // pública en v12).
    TerminusModule,
    RedisModule,
    // EmailService usado por AuthController.createInvitation para mandar
    // el link al invitado. NotificationsModule lo expone.
    NotificationsModule,
  ],
  controllers: [
    EmployeeController,
    HandshakeController,
    ScheduleController,
    RuleController,
    WhatsAppController,
    WhatsAppIncidentController,
    ShiftTemplatesController,
    ShiftMembershipsController,
    CompanySkillsController,
    CompanyPoliciesController,
    WorkingTimePolicyController,
    FairnessHistoryController,
    IncidentsController,
    ShiftSwapRequestsController,
    AbsenceReportsController,
    DayOffRequestsController,
    ShiftPreferencesController,
    ScopeTargetsController,
    DepartmentsController,
    JobsController,
    ShiftAssignmentsController,
    ShiftBreaksController,
    TasksController,
    EntityHistoryController,
    ScheduleGenerationRunsController,
    LLMUsageController,
    LLMModelBudgetsController,
    AuthController,
    AuditController,
    OnboardingController,
    AdminController,
    StripeWebhookController,
    BillingController,
    BranchesController,
    SettingsController,
    CoverageController,
    OperationalKpisController,
    OperationalBreakdownController,
    AdminPromptHistoryController,
    AdminAuditController,
    AdminJobsController,
    AdminLLMUsageController,
    AdminDashboardController,
    AdminTenantOpsController,
    AdminLLMBudgetsController,
    AdminTenantFeaturesController,
    AdminCompanyLlmAllowlistController,
    AdminLLMModelsController,
    AdminPolicyInterpretersController,
    AdminPlansController,
    AdminImpersonateController,
    AdminPlatformUsersController,
    AdminIntegrationsController,
    SupportTicketsController,
    AdminSupportTicketsController,
    AdminNotificationsController,
    HealthController,
    ImportsController,
  ],
  providers: [
    // Sprint Data Import (Fase 1) — los 3 services del subsistema de
    // importación viven acá porque solo los usa ImportsController. Si
    // a futuro un job background necesita el committer, mover a
    // ApplicationModule.
    ImportValidatorService,
    ImportPreviewBuilderService,
    ImportCommitterService,
  ],
  // Los providers del subsistema CompanyPolicy (registry, interpreters,
  // rephrase service, creator) viven en ApplicationModule junto al resto
  // de DomainServices. Acá solo declaramos los controllers HTTP — los
  // controllers reciben los servicios via el import de ApplicationModule.
})
export class InterfacesModule {}
