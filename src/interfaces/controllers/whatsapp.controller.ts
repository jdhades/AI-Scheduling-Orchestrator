import { Public } from '../../infrastructure/auth/decorators/public.decorator';
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MessageRouterService } from '../../application/conversational/message-router.service';
import { WhatsappWebhookDto } from '../dtos/whatsapp-webhook.dto';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { Inject } from '@nestjs/common';
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';

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
@Public()
@Controller('webhooks/whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);
  private readonly twilioSid: string;
  private readonly twilioToken: string;
  private readonly webhookUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly messageRouter: MessageRouterService,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly tenantFeatures: TenantFeatureService,
  ) {
    this.twilioSid = this.config.get<string>('twilio.accountSid') ?? '';
    this.twilioToken = this.config.get<string>('twilio.authToken') ?? '';
    this.webhookUrl = this.config.get<string>('twilio.webhookUrl') ?? '';
  }

  /**
   * POST /webhooks/whatsapp
   * Twilio sends a signed POST request for every incoming WhatsApp message.
   * Throttle agresivo: el volumen legítimo es bajo (empleados, no apps)
   * y Twilio retry-ea con backoff si recibe 429.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: Request,
    @Headers('x-twilio-signature') twilioSignature: string,
    @Headers('host') host: string,
  ): Promise<void> {
    const dto = req.body as WhatsappWebhookDto;
    const rawBody = req.body as Record<string, string>;
    // Sin logear el body raw — puede contener PII del empleado.
    // Solo metadata: longitud + flag de media.
    this.logger.log(
      `📩 Incoming WhatsApp webhook — bodyLen=${dto.Body?.length ?? 0}, hasMedia=${!!dto.MediaUrl0}`,
    );

    // 1. Validate Twilio signature (skip in test/development env)
    const env = this.config.get<string>('app.env');
    const skipValidation = env === 'test' || env === 'development';
    if (!skipValidation) {
      const url = this.webhookUrl || `https://${host}/webhooks/whatsapp`;
      const isValid = Twilio.validateRequest(
        this.twilioToken,
        twilioSignature,
        url,
        rawBody,
      );
      if (!isValid) {
        this.logger.warn('Invalid Twilio signature — request rejected');
        throw new ForbiddenException('Invalid Twilio signature');
      }
    }

    // 2. Dedup: Twilio retry-ea con backoff cuando el handler tarda > 15s
    //    o responde !=2xx. Si el mismo MessageSid llega 2 veces y procesamos
    //    ambas, el MessageRouter dispara doble. upsert con ignoreDuplicates
    //    devuelve count=0 cuando el sid ya existe.
    if (dto.MessageSid) {
      const { data, error: dedupErr } = await this.supabase
        .from('whatsapp_events')
        .upsert(
          { message_sid: dto.MessageSid, source: 'whatsapp' },
          { onConflict: 'message_sid', ignoreDuplicates: true },
        )
        .select('message_sid');
      if (dedupErr) {
        // Error real — loguea pero deja procesar (prefiero reprocesar
        // a perder el mensaje silenciosamente).
        this.logger.error(`whatsapp_events upsert failed: ${dedupErr.message}`);
      } else if (!data || data.length === 0) {
        // Dup ya procesado — 200 OK silencioso.
        return;
      }
    }

    // 3. Normalize the "From" number (Twilio sends "whatsapp:+1234567890")
    const rawFrom = dto.From ?? '';
    const phone = rawFrom.replace(/^whatsapp:/, '');

    if (!phone) {
      this.logger.warn('Received webhook without valid From field');
      return;
    }

    // 4. Look up employee by phone across all companies (multi-tenant lookup)
    //    Note: This query searches by phone — not by companyId yet
    const employee = await this._findEmployeeByPhone(phone);

    if (!employee) {
      this.logger.log('Unregistered number attempted to message');
      // Fire-and-forget reply — cannot call MessageRouter yet (no company context)
      return;
    }

    // 4.5 Feature flag: WhatsApp inbound debe estar habilitado para este
    //     tenant. Default ON; el admin lo puede apagar para un tenant
    //     puntual (ej. mientras debuggea un loop o suspende el servicio
    //     por billing). Retornamos 200 OK silencioso — Twilio considera
    //     entregado y no re-intenta.
    const inboundEnabled = await this.tenantFeatures.isEnabled(
      employee.companyId,
      'whatsapp_inbound',
    );
    if (!inboundEnabled) {
      this.logger.log(
        `WhatsApp inbound disabled for company=${employee.companyId} — message dropped silently`,
      );
      return;
    }

    // 5. Fire-and-forget: respond to Twilio immediately, process in background
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
