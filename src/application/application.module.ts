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
import { StructuredRuleResolver } from '../domain/services/structured-rule-resolver.service';
import { ShiftSlotGeneratorService } from '../domain/services/shift-slot-generator.service';
import { WeekScheduleBuilder } from '../domain/services/week-schedule-builder.service';
import { LLMLineProposerService } from '../domain/services/llm-line-proposer.service';

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

const ConversationalServices = [MessageRouterService, CommandMapperService];

const DomainServices = [
  SemanticRetrievalService,
  ConflictResolutionEngine,
  RuleStructureExtractor,
  StructuredRuleResolver,
  ShiftSlotGeneratorService,
  WeekScheduleBuilder,
  LLMLineProposerService,
  LlmSemanticRuleRephraseService,
];

// Suggestion-loop para SemanticRule (commit 6). El handler de
// CreateSemanticRule lo inyecta para proponer reformulaciones cuando
// intent=complex.
const PolicyDomainProviders = [
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
  exports: [CqrsModule, ...DomainServices, ...ConversationalServices],
})
export class ApplicationModule {}
