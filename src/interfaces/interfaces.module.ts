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
import { ApplicationModule } from '../application/application.module';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';
import { SupabaseModule } from '../infrastructure/supabase/supabase.module';
import { PolicyInterpreterRegistry } from '../domain/services/policy-interpreter-registry';
import { POLICY_INTERPRETERS_TOKEN } from '../domain/services/policy-interpreter.interface';
import { MinRestDaysPerWeekInterpreter } from '../domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import { RULE_REPHRASE_SERVICE } from '../domain/services/rule-rephrase.service.interface';
import { LlmRuleRephraseService } from '../domain/services/llm-rule-rephrase.service';

import { WhatsAppIncidentController } from './controllers/whatsapp-incident.controller';

@Module({
  imports: [ApplicationModule, RepositoriesModule, SupabaseModule],
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
  ],
  providers: [
    // CompanyPolicy interpreters (multi-injection bajo POLICY_INTERPRETERS_TOKEN).
    // Sumar nuevos interpreters acá los enchufa al registry sin tocar nada más.
    MinRestDaysPerWeekInterpreter,
    {
      provide: POLICY_INTERPRETERS_TOKEN,
      inject: [MinRestDaysPerWeekInterpreter],
      useFactory: (...interpreters) => interpreters,
    },
    PolicyInterpreterRegistry,
    // Suggestion-loop: cuando ningún interpreter matchea, el LLM propone
    // reformulaciones verificadas. Implementación llama al LLM_SERVICE
    // ya provisto por RepositoriesModule (Qwen / Gemini / local según
    // ai.activeProvider).
    {
      provide: RULE_REPHRASE_SERVICE,
      useClass: LlmRuleRephraseService,
    },
  ],
})
export class InterfacesModule {}
