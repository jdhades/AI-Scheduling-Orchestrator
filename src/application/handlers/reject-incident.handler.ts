import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { RejectIncidentCommand } from '../commands/reject-incident.command';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';

@CommandHandler(RejectIncidentCommand)
export class RejectIncidentHandler implements ICommandHandler<RejectIncidentCommand> {
  constructor(
    private readonly incidentRepo: IncidentRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: RejectIncidentCommand): Promise<void> {
    const incident = await this.incidentRepo.findById(
      command.incidentId,
      command.companyId,
    );
    if (!incident) {
      throw new NotFoundException(
        `Incident ${command.incidentId} not found in company ${command.companyId}`,
      );
    }

    incident.rejectIncident(command.reason);
    await this.incidentRepo.save(incident);

    for (const event of incident.getUncommittedEvents()) {
      this.eventBus.publish(event);
    }
    incident.commit();
  }
}
