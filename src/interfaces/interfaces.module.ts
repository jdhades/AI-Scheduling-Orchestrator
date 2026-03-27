import { Module } from '@nestjs/common';
import { EmployeeController } from './controllers/employee.controller';
import { HandshakeController } from './controllers/handshake.controller';
import { ScheduleController } from './controllers/schedule.controller';
import { RuleController } from './controllers/rule.controller';
import { WhatsAppController } from './controllers/whatsapp.controller';
import { ShiftTemplatesController } from './controllers/shift-templates.controller';
import { InstantiateWeekHandler } from '../application/commands/instantiate-week/instantiate-week.handler';
import { ApplicationModule } from '../application/application.module';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';

import { WhatsAppIncidentController } from './controllers/whatsapp-incident.controller';

@Module({
  imports: [ApplicationModule, RepositoriesModule],
  controllers: [
    EmployeeController,
    HandshakeController,
    ScheduleController,
    RuleController,
    WhatsAppController,
    WhatsAppIncidentController,
    ShiftTemplatesController,
  ],
  providers: [
    // Phase 2: instantiate-week command handler needs SHIFT_REPOSITORY from RepositoriesModule
    InstantiateWeekHandler,
  ],
})
export class InterfacesModule {}
