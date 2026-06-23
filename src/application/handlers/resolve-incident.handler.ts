import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { ResolveIncidentCommand } from '../commands/resolve-incident.command';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';
import { PushService } from '../../infrastructure/notifications/push.service';

@CommandHandler(ResolveIncidentCommand)
export class ResolveIncidentHandler implements ICommandHandler<ResolveIncidentCommand> {
  constructor(
    private readonly incidentRepo: IncidentRepository,
    private readonly eventBus: EventBus,
    private readonly push: PushService,
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

    // Avisar al empleado que reportó (best-effort; el aggregate ya persistió).
    void this.push.sendLocalizedToEmployees(
      command.companyId,
      [incident.employeeId],
      {
        titleKey: 'push.incident.resolved.title',
        bodyKey: 'push.incident.resolved.body',
        data: { type: 'approval' },
      },
    );

    for (const event of incident.getUncommittedEvents()) {
      this.eventBus.publish(event);
    }
    incident.commit();
  }
}
