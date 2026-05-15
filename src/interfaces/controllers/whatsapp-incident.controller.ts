import { Public } from '../../infrastructure/auth/decorators/public.decorator';
import {
  Controller,
  Headers,
  Post,
  Req,
  Res,
  HttpStatus,
  Logger,
  Inject,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CommandBus } from '@nestjs/cqrs';
import { CreateIncidentCommand } from '../../application/commands/create-incident.command';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Twilio = require('twilio');

// Hash truncado del número para logs: permite correlación sin exponer PII.
const redactPhone = (raw: string | undefined): string =>
  raw
    ? `phone:${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`
    : 'phone:?';

@Public()
@Controller('webhooks/twilio')
export class WhatsAppIncidentController {
  private readonly logger = new Logger(WhatsAppIncidentController.name);
  private readonly twilioToken: string;
  private readonly webhookUrl: string;
  private readonly env: string;

  // Consider allowed MIME types for Medical Certificates
  private readonly ALLOWED_MEDIA_TYPES = [
    'image/jpeg',
    'image/png',
    'application/pdf',
  ];

  constructor(
    private readonly commandBus: CommandBus,
    private readonly config: ConfigService,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
  ) {
    this.twilioToken = this.config.get<string>('twilio.authToken') ?? '';
    this.webhookUrl = this.config.get<string>('twilio.webhookUrl') ?? '';
    this.env = this.config.get<string>('app.env') ?? 'production';
  }

  @Post()
  async handleWhatsAppIncoming(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-twilio-signature') twilioSignature: string,
    @Headers('host') host: string,
  ): Promise<void> {
    try {
      const rawBody = req.body as Record<string, string>;

      // 0. Validate Twilio signature (skip in test/development env)
      const skipValidation = this.env === 'test' || this.env === 'development';
      if (!skipValidation) {
        const url = this.webhookUrl || `https://${host}/webhooks/twilio`;
        const isValid = Twilio.validateRequest(
          this.twilioToken,
          twilioSignature,
          url,
          rawBody,
        );
        if (!isValid) {
          this.logger.warn('Invalid Twilio signature — request rejected');
          res.status(HttpStatus.FORBIDDEN).send('Invalid Twilio signature');
          return;
        }
      }

      const { From, Body, MediaUrl0, MediaContentType0 } = req.body;

      // 1. Verify required fields (Must have a document)
      if (!From || !MediaUrl0 || !MediaContentType0) {
        this.logger.warn(
          `Missing required payload fields from ${redactPhone(From)}`,
        );
        res.status(HttpStatus.BAD_REQUEST).send('Bad Request: Missing Media');
        return;
      }

      // 2. Validate Media Type
      if (!this.ALLOWED_MEDIA_TYPES.includes(MediaContentType0)) {
        this.logger.warn(
          `Invalid media type ${MediaContentType0} from ${redactPhone(From)}`,
        );
        res
          .status(HttpStatus.BAD_REQUEST)
          .send('Bad Request: Invalid Media Type. JPG, PNG, or PDF required.');
        return;
      }

      // 3. Lookup employee by phone across all companies (wildcard lookup)
      const cleanPhone = From.replace('whatsapp:', '');
      const employee = await this.employeeRepository.findByPhone(
        cleanPhone,
        '*',
      );

      if (!employee) {
        this.logger.warn(
          `Phone number ${redactPhone(cleanPhone)} not registered in our system.`,
        );
        res
          .status(HttpStatus.BAD_REQUEST)
          .send('Bad Request: Unregistered Number');
        return;
      }

      const { companyId, id: employeeId } = employee;

      // 4. Dispatch the CQRS Command dynamically
      // Fire-and-forget logic: We respond 200 OK immediately so Twilio doesn't hang.
      res.status(HttpStatus.OK).send();

      // Process asynchronously
      setImmediate(() => {
        this.commandBus
          .execute(
            new CreateIncidentCommand(
              companyId,
              employeeId,
              Body || '',
              MediaUrl0,
            ),
          )
          .catch((error) => {
            this.logger.error(
              `Failed to process CreateIncidentCommand for ${redactPhone(From)}`,
              error.stack,
            );
          });
      });
    } catch (error) {
      this.logger.error('Error processing WhatsApp Incident Webhook', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }
  }
}
