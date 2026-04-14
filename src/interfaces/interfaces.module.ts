import { Module } from '@nestjs/common';
import { EmployeeController } from './controllers/employee.controller';
import { HandshakeController } from './controllers/handshake.controller';
import { ScheduleController } from './controllers/schedule.controller';
import { RuleController } from './controllers/rule.controller';
import { WhatsAppController } from './controllers/whatsapp.controller';
import { ShiftTemplatesController } from './controllers/shift-templates.controller';
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
})
export class InterfacesModule {}
