import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { RegisterEmployeeHandler } from './handlers/register-employee.handler';
import { GetEmployeeCalendarHandler } from './handlers/get-employee-calendar.handler';
import { EmployeeRegisteredHandler } from './handlers/employee-registered.handler';
import { InitiateHandshakeHandler } from './handlers/initiate-handshake.handler';
import { VerifyHandshakeHandler } from './handlers/verify-handshake.handler';
import { HandshakeInitiatedHandler } from './handlers/handshake-initiated.handler';
import { HandshakeVerifiedHandler } from './handlers/handshake-verified.handler';
import { GenerateScheduleHandler } from './handlers/generate-schedule.handler';
import { GenerateHybridScheduleHandler } from './handlers/generate-hybrid-schedule.handler';
import { GetCompanyScheduleHandler } from './handlers/get-company-schedule.handler';
import { CreateSemanticRuleHandler } from './handlers/create-semantic-rule.handler';
import { DeleteSemanticRuleHandler } from './handlers/delete-semantic-rule.handler';
import { GetSemanticRulesHandler } from './handlers/get-semantic-rules.handler';
import { SwapShiftHandler } from './handlers/swap-shift.handler';
import { ReportAbsenceHandler } from './handlers/report-absence.handler';
import { RequestDayOffHandler } from './handlers/request-day-off.handler';
import { GetMyScheduleHandler } from './handlers/get-my-schedule.handler';
import { GetUpcomingShiftsHandler } from './handlers/get-upcoming-shifts.handler';
import { GetCompanyEmployeesHandler } from './handlers/get-company-employees.handler';
import { ShiftSwapRequestedHandler } from './handlers/shift-swap-requested.handler';
import { AbsenceReportedHandler } from './handlers/absence-reported.handler';
import { CommandMapperService } from './conversational/command-mapper.service';
import { MessageRouterService } from './conversational/message-router.service';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';
import { NotificationsModule } from '../infrastructure/notifications/notifications.module';
import { ConversationalModule } from '../infrastructure/conversational/conversational.module';
import { WebsocketModule } from '../infrastructure/websocket/websocket.module';
import { SemanticRetrievalService } from '../domain/services/semantic-retrieval.service';
import { ConflictResolutionEngine } from '../domain/services/conflict-resolution.engine';
import { PromptOrchestratorService } from '../domain/services/prompt-orchestrator.service';
import { ScheduleValidatorService } from '../domain/services/schedule-validator.service';

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
  InitiateHandshakeHandler,
  VerifyHandshakeHandler,
  GenerateScheduleHandler,
  GenerateHybridScheduleHandler,
  CreateSemanticRuleHandler,
  DeleteSemanticRuleHandler,
  // E4 — Conversational
  SwapShiftHandler,
  ReportAbsenceHandler,
  RequestDayOffHandler,
];
const QueryHandlers = [
  GetEmployeeCalendarHandler,
  GetCompanyScheduleHandler,
  GetCompanyEmployeesHandler,
  GetSemanticRulesHandler,
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
  PromptOrchestratorService,
  ScheduleValidatorService,
];

@Module({
  imports: [
    CqrsModule,
    RepositoriesModule,
    NotificationsModule,
    ConversationalModule,
    WebsocketModule,
  ],
  providers: [
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
    ...ConversationalServices,
    ...DomainServices,
  ],
  exports: [CqrsModule, ...DomainServices, ...ConversationalServices],
})
export class ApplicationModule {}
