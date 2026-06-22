import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { RejectIncidentCommand } from '../commands/reject-incident.command';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';
import { PushService } from '../../infrastructure/notifications/push.service';

@CommandHandler(RejectIncidentCommand)
export class RejectIncidentHandler implements ICommandHandler<RejectIncidentCommand> {
  constructor(
    private readonly incidentRepo: IncidentRepository,
    private readonly eventBus: EventBus,
    private readonly push: PushService,
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

    // Avisar al empleado que reportó (best-effort; el aggregate ya persistió).
    void this.push.sendToEmployees(command.companyId, [incident.employeeId], {
      title: 'Incidente rechazado',
      body: 'Tu incidente reportado fue rechazado por tu manager.',
      data: { type: 'approval' },
    });

    for (const event of incident.getUncommittedEvents()) {
      this.eventBus.publish(event);
    }
    incident.commit();
  }
}
