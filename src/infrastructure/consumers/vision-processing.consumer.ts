import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { createClient, RedisClientType } from 'redis';
import { ProcessIncidentEvidenceCommand } from '../../application/commands/process-incident-evidence.command';

@Injectable()
export class VisionProcessingConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VisionProcessingConsumer.name);
  private client: RedisClientType;
  private isProcessing = false;
  private readonly streamName = 'incident_processing_stream';
  private readonly consumerGroup = 'vision_processing_group';
  private readonly consumerName = `consumer_${Math.random().toString(36).substring(7)}`;

  constructor(private readonly commandBus: CommandBus) {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    this.client.on('error', (err) =>
      this.logger.error('Redis Consumer Client Error', err),
    );
  }

  async onModuleInit() {
    await this.client.connect();
    await this.createConsumerGroup();

    this.isProcessing = true;
    this.pollStream();
  }

  async onModuleDestroy() {
    this.isProcessing = false;
    await this.client.quit();
  }

  private async createConsumerGroup() {
    try {
      // Force creating the stream and the group, ignoring if it already exists
      await this.client.xGroupCreate(this.streamName, this.consumerGroup, '0', {
        MKSTREAM: true,
      });
      this.logger.log(
        `Created consumer group ${this.consumerGroup} for stream ${this.streamName}`,
      );
    } catch (e: any) {
      if (!e.message.includes('BUSYGROUP')) {
        this.logger.error('Error creating consumer group', e);
      }
    }
  }

  private async pollStream() {
    while (this.isProcessing) {
      try {
        // Read 1 message, block for 5 seconds if empty
        const response = await this.client.xReadGroup(
          this.consumerGroup,
          this.consumerName,
          [
            {
              key: this.streamName,
              id: '>', // '>' means read new messages never delivered to other consumers
            },
          ],
          { COUNT: 1, BLOCK: 5000 },
        );

        if (response && response.length > 0) {
          const stream = response[0];
          for (const message of stream.messages) {
            const { incidentId, employeeId, evidenceUrl } =
              message.message as any;

            this.logger.log(
              `Processing message ${message.id} for incident ${incidentId}`,
            );

            try {
              // Fire the application command to process the incident OCR and Validation
              await this.commandBus.execute(
                new ProcessIncidentEvidenceCommand(
                  incidentId,
                  employeeId,
                  evidenceUrl,
                ),
              );

              // Acknowledge the message so it's removed from PEL (Pending Entries List)
              await this.client.xAck(
                this.streamName,
                this.consumerGroup,
                message.id,
              );
              this.logger.log(`Message ${message.id} ACKed successfully`);
            } catch (err: any) {
              this.logger.error(
                `Failed to process message ${message.id}: ${err.message}`,
              );
              // Did not ACK -> It stays in the Pending list. Phase 14 (Job System) can reclaim it later.
            }
          }
        }
      } catch (err: any) {
        // Ignore generic read timeouts
        if (err.name !== 'ConnectionTimeoutError') {
          this.logger.error('Error reading from Redis Stream', err);
          // Wait briefly to avoid tight error looping
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }
}
