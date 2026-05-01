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
import { ScopeTargetsController } from './controllers/scope-targets.controller';
import { DepartmentsController } from './controllers/departments.controller';
import { ApplicationModule } from '../application/application.module';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';
import { SupabaseModule } from '../infrastructure/supabase/supabase.module';

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
    ScopeTargetsController,
    DepartmentsController,
  ],
  // Los providers del subsistema CompanyPolicy (registry, interpreters,
  // rephrase service, creator) viven en ApplicationModule junto al resto
  // de DomainServices. Acá solo declaramos los controllers HTTP — los
  // controllers reciben los servicios via el import de ApplicationModule.
})
export class InterfacesModule {}
