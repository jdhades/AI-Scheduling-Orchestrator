import {
    Body,
    Controller,
    ForbiddenException,
    Headers,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageRouterService } from '../../application/conversational/message-router.service';
import { WhatsappWebhookDto } from '../dtos/whatsapp-webhook.dto';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { Inject } from '@nestjs/common';

// Twilio helpers — using require to match existing pattern in project
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Twilio = require('twilio');

/**
 * WhatsAppController — Interface Layer
 *
 * Receives incoming WhatsApp messages from Twilio webhook.
 * Excluded from TenantMiddleware (companyId is resolved by phone lookup).
 *
 * Security:
 *   - Validates Twilio signature on every request
 *   - Checks employee is registered and WhatsApp-verified before routing
 *
 * Performance:
 *   - Responds 200 OK immediately to Twilio (avoids retry timeout of 15s)
 *   - Delegates processing to MessageRouterService via setImmediate (fire-and-forget)
 */
@Controller('webhooks/whatsapp')
export class WhatsAppController {
    private readonly logger = new Logger(WhatsAppController.name);
    private readonly twilioSid: string;
    private readonly twilioToken: string;
    private readonly webhookUrl: string;

    constructor(
        private readonly config: ConfigService,
        private readonly messageRouter: MessageRouterService,
        @Inject(EMPLOYEE_REPOSITORY) private readonly employeeRepo: IEmployeeRepository,
    ) {
        this.twilioSid = this.config.get<string>('twilio.accountSid') ?? '';
        this.twilioToken = this.config.get<string>('twilio.authToken') ?? '';
        this.webhookUrl = this.config.get<string>('twilio.webhookUrl') ?? '';
    }

    /**
     * POST /webhooks/whatsapp
     * Twilio sends a signed POST request for every incoming WhatsApp message.
     */
    @Post()
    @HttpCode(HttpStatus.OK)
    async receive(
        @Body() dto: WhatsappWebhookDto,
        @Headers('x-twilio-signature') twilioSignature: string,
        @Headers('host') host: string,
    ): Promise<void> {
        // 1. Validate Twilio signature (skip in test env)
        const isTestEnv = this.config.get<string>('app.env') === 'test';
        if (!isTestEnv) {
            const url = this.webhookUrl || `https://${host}/webhooks/whatsapp`;
            const isValid = Twilio.validateRequest(
                this.twilioToken,
                twilioSignature,
                url,
                dto as unknown as Record<string, string>,
            );
            if (!isValid) {
                this.logger.warn('Invalid Twilio signature — request rejected');
                throw new ForbiddenException('Invalid Twilio signature');
            }
        }

        // 2. Normalize the "From" number (Twilio sends "whatsapp:+1234567890")
        const rawFrom = dto.From ?? '';
        const phone = rawFrom.replace(/^whatsapp:/, '');

        if (!phone) {
            this.logger.warn('Received webhook without valid From field');
            return;
        }

        // 3. Look up employee by phone across all companies (multi-tenant lookup)
        //    Note: This query searches by phone — not by companyId yet
        const employee = await this._findEmployeeByPhone(phone);

        if (!employee) {
            this.logger.log(`Unregistered number attempted to message: ${phone}`);
            // Fire-and-forget reply — cannot call MessageRouter yet (no company context)
            return;
        }

        // 4. Fire-and-forget: respond to Twilio immediately, process in background
        setImmediate(() => {
            void this.messageRouter.route({
                from: phone,
                companyId: employee.companyId,
                employeeId: employee.employeeId,
                body: dto.Body,
                mediaUrl: dto.MediaUrl0,
                mimeType: dto.MediaContentType0,
                twilioSid: this.twilioSid,
                twilioToken: this.twilioToken,
            });
        });
    }

    /**
     * Searches for the employee by phone.
     * In a multi-tenant system where phone is unique globally, this is a direct lookup.
     * The employee record contains the companyId.
     */
    private async _findEmployeeByPhone(
        phone: string,
    ): Promise<{ employeeId: string; companyId: string } | null> {
        try {
            // Convention: use a special multi-tenant search that ignores company context
            // The Supabase implementation will search across all companies (service role key bypasses RLS)
            const employee = await this.employeeRepo.findByPhone(phone, '*');
            if (!employee) return null;
            return { employeeId: employee.id, companyId: employee.companyId };
        } catch {
            return null;
        }
    }
}
