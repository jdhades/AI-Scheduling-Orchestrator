import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { CreateIncidentCommand } from '../commands/create-incident.command';
import {
  Incident,
  IncidentType,
} from '../../domain/aggregates/incident.aggregate';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';

@CommandHandler(CreateIncidentCommand)
export class CreateIncidentHandler implements ICommandHandler<CreateIncidentCommand> {
  constructor(
    private readonly incidentRepository: IncidentRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CreateIncidentCommand): Promise<void> {
    const { companyId, employeeId, message, mediaUrl } = command;

    // 1 & 2. Generate IncidentId and create Aggregate (status defaults to REPORTED)
    // Here we hardcode MEDICAL_LEAVE for now as per Scenario 5 primary use case
    // The "message" could be processed by LLM to infer the type, but since a certificate is sent, assume MEDICAL_LEAVE.
    const incident = Incident.reportIncident(
      companyId,
      employeeId,
      IncidentType.MEDICAL_LEAVE,
    );

    // 3. Attach evidenceUrl and state moves to PENDING_OCR
    incident.attachEvidence(mediaUrl);

    // 5. Persist the incident entity state
    await this.incidentRepository.save(incident);

    // 6. Publish the uncommitted events to the EventBus (IncidentReportedEvent, EvidenceAttachedEvent)
    // The EventBus will dispatch them to synchronous handlers OR our Redis Stream publisher
    const events = incident.getUncommittedEvents();
    for (const event of events) {
      this.eventBus.publish(event);
    }
    incident.commit(); // Clear events after publishing
  }
}
