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
    const hasMedia = !!mediaUrl;

    // Dos flujos sobre el mismo command:
    // - CON media (WhatsApp, certificado): medical-leave → OCR (PENDING_OCR).
    // - SIN media (POST /incidents/report desde la app): reporte libre del
    //   empleado, tipo GENERAL; guardamos su `message` y queda REPORTED para
    //   que el manager lo vea y lo resuelva/rechace (no pasa por OCR).
    const incident = Incident.reportIncident(
      companyId,
      employeeId,
      hasMedia ? IncidentType.MEDICAL_LEAVE : IncidentType.GENERAL,
      hasMedia ? null : message || null,
    );

    if (hasMedia) {
      // Attach evidenceUrl → state moves to PENDING_OCR.
      incident.attachEvidence(mediaUrl);
    }

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
