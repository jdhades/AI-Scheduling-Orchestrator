import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { EvidenceAttachedEvent } from '../../domain/events/evidence-attached.event';
import { RedisStreamService } from '../../infrastructure/redis/redis-stream.service';
import { Logger } from '@nestjs/common';

@EventsHandler(EvidenceAttachedEvent)
export class PublishIncidentToStreamHandler
    implements IEventHandler<EvidenceAttachedEvent> {
    private readonly logger = new Logger(PublishIncidentToStreamHandler.name);

    constructor(private readonly redisStreamService: RedisStreamService) { }

    async handle(event: EvidenceAttachedEvent) {
        this.logger.log(`Handling EvidenceAttachedEvent for incident ${event.incidentId}`);

        // Tarea 9: Publicar al stream
        await this.redisStreamService.publishIncidentCreated(
            event.incidentId,
            event.employeeId,
            event.payload.evidenceUrl,
        );
    }
}
