import {
    Controller,
    Post,
    Req,
    Res,
    HttpStatus,
    Logger,
    Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CommandBus } from '@nestjs/cqrs';
import { CreateIncidentCommand } from '../../application/commands/create-incident.command';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';

@Controller('webhooks/twilio')
export class WhatsAppIncidentController {
    private readonly logger = new Logger(WhatsAppIncidentController.name);

    // Consider allowed MIME types for Medical Certificates
    private readonly ALLOWED_MEDIA_TYPES = [
        'image/jpeg',
        'image/png',
        'application/pdf',
    ];

    constructor(
        private readonly commandBus: CommandBus,
        @Inject(EMPLOYEE_REPOSITORY) private readonly employeeRepository: IEmployeeRepository,
    ) { }

    @Post()
    async handleWhatsAppIncoming(
        @Req() req: Request,
        @Res() res: Response,
    ): Promise<void> {
        try {
            const {
                From,
                Body,
                MediaUrl0,
                MediaContentType0,
            } = req.body;

            // 1. Verify required fields (Must have a document)
            if (!From || !MediaUrl0 || !MediaContentType0) {
                this.logger.warn(`Missing required payload fields from ${From}`);
                res.status(HttpStatus.BAD_REQUEST).send('Bad Request: Missing Media');
                return;
            }

            // 2. Validate Media Type
            if (!this.ALLOWED_MEDIA_TYPES.includes(MediaContentType0)) {
                this.logger.warn(
                    `Invalid media type ${MediaContentType0} from ${From}`,
                );
                res
                    .status(HttpStatus.BAD_REQUEST)
                    .send('Bad Request: Invalid Media Type. JPG, PNG, or PDF required.');
                return;
            }

            // 3. Lookup employee by phone across all companies (wildcard lookup)
            const cleanPhone = From.replace('whatsapp:', '');
            const employee = await this.employeeRepository.findByPhone(cleanPhone, '*');

            if (!employee) {
                this.logger.warn(`Phone number ${cleanPhone} not registered in our system.`);
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
                            `Failed to process CreateIncidentCommand for ${From}`,
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
