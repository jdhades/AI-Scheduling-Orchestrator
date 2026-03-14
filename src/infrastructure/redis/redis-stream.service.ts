import { Injectable, Logger } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisStreamService {
    private readonly logger = new Logger(RedisStreamService.name);
    private client: RedisClientType;

    constructor() {
        // In production, fetch URL from ConfigService
        this.client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
        this.client.on('error', (err) => this.logger.error('Redis Client Error', err));
        this.client.connect().catch(console.error);
    }

    async publishIncidentCreated(
        incidentId: string,
        employeeId: string,
        evidenceUrl: string,
    ): Promise<void> {
        try {
            const streamName = 'incident_processing_stream';

            // XADD key * field string field string ...
            const id = await this.client.xAdd(streamName, '*', {
                incidentId,
                employeeId,
                evidenceUrl,
            });

            this.logger.log(`Published incident ${incidentId} to stream ${streamName} with ID ${id}`);
        } catch (error) {
            this.logger.error(`Failed to publish to stream for incident ${incidentId}`, error);
            throw error;
        }
    }

    // Graceful shutdown
    async onModuleDestroy() {
        await this.client.quit();
    }
}
