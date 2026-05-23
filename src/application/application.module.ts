import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { RegisterEmployeeHandler } from './handlers/register-employee.handler';
import { UpdateEmployeeHandler } from './handlers/update-employee.handler';
import { DeleteEmployeeHandler } from './handlers/delete-employee.handler';
import { GetEmployeeByIdHandler } from './handlers/get-employee-by-id.handler';
import { GetEmployeeCalendarHandler } from './handlers/get-employee-calendar.handler';
import { EmployeeRegisteredHandler } from './handlers/employee-registered.handler';
import { InitiateHandshakeHandler } from './handlers/initiate-handshake.handler';
import { VerifyHandshakeHandler } from './handlers/verify-handshake.handler';
import { HandshakeInitiatedHandler } from './handlers/handshake-initiated.handler';
import { HandshakeVerifiedHandler } from './handlers/handshake-verified.handler';
import { GenerateHybridScheduleHandler } from './handlers/generate-hybrid-schedule.handler';
import { CloneScheduleHandler } from './handlers/clone-schedule.handler';
import { GetCompanyScheduleHandler } from './handlers/get-company-schedule.handler';
import { CreateSemanticRuleHandler } from './handlers/create-semantic-rule.handler';
import { DeleteSemanticRuleHandler } from './handlers/delete-semantic-rule.handler';
import { GetSemanticRulesHandler } from './handlers/get-semantic-rules.handler';
import { GetSemanticRuleByIdHandler } from './handlers/get-semantic-rule-by-id.handler';
import { UpdateSemanticRuleMetadataHandler } from './handlers/update-semantic-rule-metadata.handler';
import { UpdateSemanticRuleTextHandler } from './handlers/update-semantic-rule-text.handler';
import { SwapShiftHandler } from './handlers/swap-shift.handler';
import { TakeOpenShiftHandler } from './handlers/take-open-shift.handler';
import { ReportAbsenceHandler } from './handlers/report-absence.handler';
import { RequestDayOffHandler } from './handlers/request-day-off.handler';
import { GetMyScheduleHandler } from './handlers/get-my-schedule.handler';
import { GetUpcomingShiftsHandler } from './handlers/get-upcoming-shifts.handler';
import { GetCompanyEmployeesHandler } from './handlers/get-company-employees.handler';
import { ShiftSwapRequestedHandler } from './handlers/shift-swap-requested.handler';
import { AbsenceReportedHandler } from './handlers/absence-reported.handler';
import { CreateIncidentHandler } from './handlers/create-incident.handler';
import { RejectIncidentHandler } from './handlers/reject-incident.handler';
import { ResolveIncidentHandler } from './handlers/resolve-incident.handler';
import { GetIncidentsHandler } from './handlers/get-incidents.handler';
import { GetIncidentByIdHandler } from './handlers/get-incident-by-id.handler';
import { CommandMapperService } from './conversational/command-mapper.service';
import { MessageRouterService } from './conversational/message-router.service';
import { PolicyScopeResolver } from './conversational/policy-scope-resolver.service';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';
import { NotificationsModule } from '../infrastructure/notifications/notifications.module';
import { ConversationalModule } from '../infrastructure/conversational/conversational.module';
import { WebsocketModule } from '../infrastructure/websocket/websocket.module';
import { SupabaseModule } from '../infrastructure/supabase/supabase.module';
import { SemanticRetrievalService } from '../domain/services/semantic-retrieval.service';
import { ConflictResolutionEngine } from '../domain/services/conflict-resolution.engine';
import { RuleStructureExtractor } from '../domain/services/rule-structure-extractor.service';
import { LlmSemanticRuleRephraseService } from '../domain/services/llm-semantic-rule-rephrase.service';
import { SEMANTIC_RULE_REPHRASE_SERVICE } from '../domain/services/semantic-rule-rephrase.service.interface';
import { PolicyInterpreterRegistry } from '../domain/services/policy-interpreter-registry';
import { POLICY_INTERPRETERS_TOKEN } from '../domain/services/policy-interpreter.interface';
import { MinRestDaysPerWeekInterpreter } from '../domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import { MinRestHoursBetweenShiftsInterpreter } from '../domain/services/policy-interpreters/min-rest-hours-between-shifts.interpreter';
import { LLMRuntimeInterpreter } from '../domain/services/policy-interpreters/llm-runtime.interpreter';
import { RULE_REPHRASE_SERVICE } from '../domain/services/rule-rephrase.service.interface';
import { LlmRuleRephraseService } from '../domain/services/llm-rule-rephrase.service';
import { CompanyPolicyCreator } from '../domain/services/company-policy-creator.service';
import { PolicyEnforcementService } from '../domain/services/policy-enforcement.service';
import { StructuredRuleResolver } from '../domain/services/structured-rule-resolver.service';
import { ShiftSlotGeneratorService } from '../domain/services/shift-slot-generator.service';
import { WeekScheduleBuilder } from '../domain/services/week-schedule-builder.service';
import { LLMLineProposerService } from '../domain/services/llm-line-proposer.service';
import { ManagerScopeService } from './services/manager-scope.service';
import { ManagerNotificationService } from './services/manager-notification.service';
import { CompanyPreferencesService } from './services/company-preferences.service';
import { TenantFeatureService } from '../domain/services/tenant-feature.service';
import { LlmResolverService } from './services/llm-resolver.service';
import { CoverageService } from '../domain/services/coverage.service';
import { OperationalKpisService } from '../domain/services/operational-kpis.service';
import { OperationalBreakdownService } from '../domain/services/operational-breakdown.service';
import { AbsenceReportCreator } from '../domain/services/absence-report-creator.service';
import { ScheduleGenerationLockService } from '../domain/services/schedule-generation-lock.service';
import { ScheduleGenerationRunsService } from '../domain/services/schedule-generation-runs.service';
import { LLMModelBudgetService } from '../domain/services/llm-model-budget.service';
import { ShiftAssignmentMoverService } from '../domain/services/shift-assignment-mover.service';
import { ShiftAssignmentCreatorService } from '../domain/services/shift-assignment-creator.service';
import { FairnessHistoryRecomputerService } from '../domain/services/fairness-history-recomputer.service';
import { ShiftBreakManager } from '../domain/services/shift-break-manager.service';
import { ScheduleGenerationJobHandler } from './jobs/schedule-generation-job.handler';
import { ScheduleGenerationDeadletterHandler } from './jobs/schedule-generation-deadletter.handler';
import { ScheduleGenerationDispatcher } from './jobs/schedule-generation-dispatcher.service';
import { LlmJobDispatcher } from './jobs/llm-job-dispatcher.service';
import { LlmJobWorker } from './jobs/llm-job.worker';

/**
 * ApplicationModule
 *
 * Registra todos los CommandHandlers, QueryHandlers y EventHandlers.
 * Importa RepositoriesModule para que los handlers puedan inyectar
 * EMPLOYEE_REPOSITORY y HANDSHAKE_REPOSITORY.
 * Exporta CqrsModule para que la interfaces layer acceda al CommandBus/QueryBus.
 */
const CommandHandlers = [
  RegisterEmployeeHandler,
  UpdateEmployeeHandler,
  DeleteEmployeeHandler,
  InitiateHandshakeHandler,
  VerifyHandshakeHandler,
  GenerateHybridScheduleHandler,
  // Clona el horario de una semana a N semanas destino. Pre-checkea
  // day-offs/absences en target; opcional overwrite. Reusa el path
  // estándar de save + dispara fairness recompute por (employee, week).
  CloneScheduleHandler,
  CreateSemanticRuleHandler,
  UpdateSemanticRuleMetadataHandler,
  UpdateSemanticRuleTextHandler,
  DeleteSemanticRuleHandler,
  // E4 — Conversational
  SwapShiftHandler,
  TakeOpenShiftHandler,
  ReportAbsenceHandler,
  RequestDayOffHandler,
  // E5 — Incidents
  CreateIncidentHandler,
  RejectIncidentHandler,
  ResolveIncidentHandler,
];
const QueryHandlers = [
  GetEmployeeByIdHandler,
  GetEmployeeCalendarHandler,
  GetIncidentsHandler,
  GetIncidentByIdHandler,
  GetCompanyScheduleHandler,
  GetCompanyEmployeesHandler,
  GetSemanticRulesHandler,
  GetSemanticRuleByIdHandler,
  GetMyScheduleHandler,
  GetUpcomingShiftsHandler,
];
const EventHandlers = [
  EmployeeRegisteredHandler,
  HandshakeInitiatedHandler,
  HandshakeVerifiedHandler,
  // E4 — Conversational events
  ShiftSwapRequestedHandler,
  AbsenceReportedHandler,
];

const ConversationalServices = [MessageRouterService, CommandMapperService, PolicyScopeResolver];

const DomainServices = [
  SemanticRetrievalService,
  ConflictResolutionEngine,
  RuleStructureExtractor,
  StructuredRuleResolver,
  ShiftSlotGeneratorService,
  WeekScheduleBuilder,
  LLMLineProposerService,
  LlmSemanticRuleRephraseService,
  // Subsistema CompanyPolicy (commits 1-9 + follow-up): registry +
  // interpreters + rephrase service + creator. Antes vivían en
  // InterfacesModule; los moví acá para que el MessageRouter (que
  // está en ApplicationModule) los pueda inyectar sin cruzar a
  // Interfaces (que ya importa Application — sería circular).
  MinRestDaysPerWeekInterpreter,
  MinRestHoursBetweenShiftsInterpreter,
  LLMRuntimeInterpreter,
  PolicyInterpreterRegistry,
  LlmRuleRephraseService,
  CompanyPolicyCreator,
  // MVP de integración solver: el WeekScheduleBuilder lo puede inyectar
  // cuando esté listo para consumir policies activas (evaluate() para
  // verificación post-generation, formatForPrompt() para el LLM repair).
  PolicyEnforcementService,
  // Phase 15.2 — resuelve "qué empleados ve un manager" para filtrar
  // las listas de approvals (swap/absence/incident/day-off).
  ManagerScopeService,
  // Phase 15.2 — resuelve a qué manager mandar la notificación WhatsApp
  // de una approval (origen = depto del employee). Reemplaza el env var
  // global MANAGER_WHATSAPP_NUMBER.
  ManagerNotificationService,
  // Sprint week_starts_on — lookup cacheado (TTL 5min) de prefs tenant-wide.
  // Lo inyectan handlers/services que necesitan normalizar fechas al
  // inicio-de-semana del tenant en lugar de hardcodear lunes.
  CompanyPreferencesService,
  // Sprint admin: feature flags per-tenant. Catálogo en código,
  // overrides en BD. Consumers leen via TenantFeatureService.isEnabled.
  TenantFeatureService,
  // Sprint admin/soporte — devuelve el ILLMService apropiado por tenant
  // (companies.llm_provider). Sin pref configurada → env-wide default.
  LlmResolverService,
  // Coverage heatmap: cobertura (assigned vs required) por día×hora para
  // una semana. Lee templates + assignments del tenant; no persiste.
  CoverageService,
  // KPIs operacionales tenant-wide para el dashboard del manager/owner:
  // coverage avg, approval rate, fairness CV, generaciones del período.
  OperationalKpisService,
  // Drill-down de KPIs por dept / empleado / turno + métricas
  // cross-cutting (channel split, schedule churn, WhatsApp activity).
  OperationalBreakdownService,
  // Phase 17.2 — unifica el alta de absence reports entre WhatsApp y
  // panel. Borra assignments del range, calcula urgencia, publica event.
  AbsenceReportCreator,
  // Fase 0 async migration — lock por (company_id, week_start) que
  // serializa runs sincronicos de generate_schedule. Se va a complementar
  // con pg-boss singletonKey cuando entre la cola.
  ScheduleGenerationLockService,
  // F.6 — historial de runs (completed/failed/cancelled) para el
  // dashboard. Worker handler escribe al cerrar el job.
  ScheduleGenerationRunsService,
  // F.6 — budgets de tokens por modelo LLM. CRUD para que el manager
  // configure el techo mensual; el dashboard muestra consumido vs total.
  LLMModelBudgetService,
  // Phase 19 — drag & drop manual: mueve una assignment a otro
  // empleado/día con validación de conflicto + audit en BD + WS event.
  ShiftAssignmentMoverService,
  // Phase 19E — creación manual de assignments desde el panel.
  ShiftAssignmentCreatorService,
  // Recompute single-row de fairness_history tras mutaciones manuales
  // de assignments (create/move/delete/take-open/swap). Sin esto, los
  // KPIs del dashboard (promedio horas, breakdown por dept/empleado,
  // fairness CV) quedan con la foto vieja entre regeneraciones.
  FairnessHistoryRecomputerService,
  // Sprint Add-a-break: domain service que gestiona breaks intra-shift
  // (validación de fit + no overlap + materialización de defaults del
  // template). El controller lo inyecta directo, el creator lo usa
  // para materializar defaults al crear un assignment.
  ShiftBreakManager,
  // Fase 1 async migration — dispatcher (encola con singletonKey),
  // worker (procesa) y dead-letter handler (notifica fallo terminal).
  // Los workers usan OnApplicationBootstrap para subscribir después
  // que pg-boss + las queues están listas.
  ScheduleGenerationDispatcher,
  ScheduleGenerationJobHandler,
  ScheduleGenerationDeadletterHandler,
  // Sprint async LLM: dispatcher único + worker que sirve 3 queues
  // (create_rule, update_rule_text, process_incident_evidence).
  // Reusa los CommandHandlers existentes via CommandBus.
  LlmJobDispatcher,
  LlmJobWorker,
];

const PolicyDomainProviders = [
  // Multi-injection: el registry recibe la lista de interpreters via
  // POLICY_INTERPRETERS_TOKEN. Sumar nuevos = sumar al inject array.
  {
    provide: POLICY_INTERPRETERS_TOKEN,
    inject: [
      MinRestDaysPerWeekInterpreter,
      MinRestHoursBetweenShiftsInterpreter,
      LLMRuntimeInterpreter,
    ],
    useFactory: (...interpreters: unknown[]) => interpreters,
  },
  // Token-binding del rephrase service usado por CompanyPolicyCreator.
  {
    provide: RULE_REPHRASE_SERVICE,
    useExisting: LlmRuleRephraseService,
  },
  // Suggestion-loop para SemanticRule (commit 6). El handler de
  // CreateSemanticRule lo inyecta cuando intent=complex.
  {
    provide: SEMANTIC_RULE_REPHRASE_SERVICE,
    useExisting: LlmSemanticRuleRephraseService,
  },
];

@Module({
  imports: [
    CqrsModule,
    RepositoriesModule,
    NotificationsModule,
    ConversationalModule,
    WebsocketModule,
    SupabaseModule,
  ],
  providers: [
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
    ...ConversationalServices,
    ...DomainServices,
    ...PolicyDomainProviders,
  ],
  exports: [
    CqrsModule,
    ...DomainServices,
    ...ConversationalServices,
    // Tokens del subsistema CompanyPolicy: el controller HTTP de
    // /company-policies (en InterfacesModule) los inyecta.
    POLICY_INTERPRETERS_TOKEN,
    RULE_REPHRASE_SERVICE,
    SEMANTIC_RULE_REPHRASE_SERVICE,
  ],
})
export class ApplicationModule {}
