import { Module } from '@nestjs/common';
import { EmployeeController } from './controllers/employee.controller';
import { HandshakeController } from './controllers/handshake.controller';
import { ScheduleController } from './controllers/schedule.controller';
import { RuleController } from './controllers/rule.controller';
import { WhatsAppController } from './controllers/whatsapp.controller';
import { ApplicationModule } from '../application/application.module';
import { RepositoriesModule } from '../infrastructure/repositories/repositories.module';

@Module({
    imports: [ApplicationModule, RepositoriesModule],
    controllers: [
        EmployeeController,
        HandshakeController,
        ScheduleController,
        RuleController,
        WhatsAppController,
    ],
})
export class InterfacesModule { }
