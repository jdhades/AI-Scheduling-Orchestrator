import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { ResolveIncidentCommand } from '../commands/resolve-incident.command';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';

@CommandHandler(ResolveIncidentCommand)
export class ResolveIncidentHandler
  implements ICommandHandler<ResolveIncidentCommand>
{
  constructor(
    private readonly incidentRepo: IncidentRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ResolveIncidentCommand): Promise<void> {
    const incident = await this.incidentRepo.findById(
      command.incidentId,
      command.companyId,
    );
    if (!incident) {
      throw new NotFoundException(
        `Incident ${command.incidentId} not found in company ${command.companyId}`,
      );
    }

    incident.resolveIncident(command.details);
    await this.incidentRepo.save(incident);

    for (const event of incident.getUncommittedEvents()) {
      this.eventBus.publish(event);
    }
    incident.commit();
  }
}
