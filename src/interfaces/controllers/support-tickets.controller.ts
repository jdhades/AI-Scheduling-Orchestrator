import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Roles } from '../../infrastructure/auth/decorators/roles.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';

export type Severity = 'low' | 'medium' | 'high';
export type Area =
  | 'schedule'
  | 'rules'
  | 'policies'
  | 'whatsapp'
  | 'billing'
  | 'auth'
  | 'other';
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface SupportTicketRow {
  id: string;
  companyId: string;
  reporterEmployeeId: string | null;
  reporterEmail: string | null;
  title: string;
  description: string;
  severity: Severity;
  area: Area;
  status: TicketStatus;
  resolution: string | null;
  resolvedAt: string | null;
  clientContext: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
}

class CreateTicketDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  description!: string;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  severity?: Severity;

  @IsOptional()
  @IsIn(['schedule', 'rules', 'policies', 'whatsapp', 'billing', 'auth', 'other'])
  area?: Area;

  @IsOptional()
  @IsObject()
  clientContext?: Record<string, unknown>;
}

/**
 * SupportTicketsController — tenant submits + lists own tickets.
 *
 *   POST /support-tickets          → manager/owner crea
 *   GET  /support-tickets          → manager/owner lista los del propio tenant
 *
 * Attachments están programados pero apagados — el endpoint para
 * crear/listar attachments responde 503 mientras la feature flag
 * `support_ticket_attachments` esté off para el tenant. El flag se
 * gestiona desde /admin/companies/:id/features.
 */
@Controller('support-tickets')
@AllowExpiredTrial()
export class SupportTicketsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly features: TenantFeatureService,
  ) {}

  @Post()
  @Roles('owner', 'manager')
  async create(
    @CurrentUser() user: AuthContext,
    @CurrentCompany() companyId: string,
    @Body() dto: CreateTicketDto,
  ): Promise<SupportTicketRow> {
    let reporterEmail: string | null = null;
    if (user.userId) {
      const { data } = await this.supabase.auth.admin.getUserById(user.userId);
      reporterEmail = data.user?.email ?? null;
    }

    const { data, error } = await this.supabase
      .from('support_tickets')
      .insert({
        company_id: companyId,
        reporter_employee_id: user.employeeId ?? null,
        reporter_auth_user_id: user.userId,
        reporter_email: reporterEmail,
        title: dto.title.trim(),
        description: dto.description.trim(),
        severity: dto.severity ?? 'medium',
        area: dto.area ?? 'other',
        client_context: dto.clientContext ?? null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return this.toRow(data, 0);
  }

  @Get()
  @Roles('owner', 'manager')
  async list(
    @CurrentCompany() companyId: string,
  ): Promise<SupportTicketRow[]> {
    const { data, error } = await this.supabase
      .from('support_tickets')
      .select('*, support_ticket_attachments(count)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => {
      const attachments = (r.support_ticket_attachments ?? []) as Array<{
        count: number;
      }>;
      return this.toRow(r, attachments[0]?.count ?? 0);
    });
  }

  /**
   * POST /support-tickets/:id/attachments
   *
   * Crea el row + devuelve un signed upload URL del bucket de Supabase
   * Storage. El frontend sube el archivo y después llama a
   * confirmAttachment para marcar uploaded_at.
   *
   * GATED por feature flag `support_ticket_attachments` por tenant. Sin
   * el flag, responde 503 y el frontend hidea el input file.
   */
  @Post(':id/attachments')
  @Roles('owner', 'manager')
  async startAttachmentUpload(
    @CurrentCompany() companyId: string,
    @Param('id') ticketId: string,
    @Body() body: { fileName: string; mimeType?: string; sizeBytes?: number },
  ): Promise<{
    attachmentId: string;
    bucket: string;
    storagePath: string;
    uploadUrl: string | null;
    token: string | null;
  }> {
    const enabled = await this.features.isEnabled(
      companyId,
      'support_ticket_attachments',
    );
    if (!enabled) {
      throw new ServiceUnavailableException(
        'Attachments uploads are not enabled for this tenant',
      );
    }

    const ticket = await this.assertTicketBelongsToTenant(ticketId, companyId);
    if (!ticket) throw new NotFoundException('Ticket not found');

    if (!body.fileName) {
      throw new BadRequestException('fileName is required');
    }

    const ext = body.fileName.includes('.')
      ? body.fileName.split('.').pop()
      : null;
    const storagePath = `tickets/${ticketId}/${cryptoRandomId()}${ext ? '.' + ext : ''}`;
    const bucket = 'support-attachments';

    const { data: row, error: insertErr } = await this.supabase
      .from('support_ticket_attachments')
      .insert({
        ticket_id: ticketId,
        storage_path: storagePath,
        bucket,
        mime_type: body.mimeType ?? null,
        size_bytes: body.sizeBytes ?? null,
      })
      .select('id')
      .single();
    if (insertErr) throw new BadRequestException(insertErr.message);

    // Solicitamos el signed upload URL al bucket. Si el bucket NO existe
    // todavía, Supabase devuelve error — propagamos como 503 para que
    // el operador sepa que falta crear el bucket.
    let uploadUrl: string | null = null;
    let token: string | null = null;
    try {
      const { data: signed, error: signedErr } = await this.supabase
        .storage
        .from(bucket)
        .createSignedUploadUrl(storagePath);
      if (signedErr) throw signedErr;
      uploadUrl = signed.signedUrl;
      token = signed.token;
    } catch (err) {
      // Cleanup: borramos la row para no dejar attachments huérfanos
      // cuando el storage no está configurado.
      await this.supabase
        .from('support_ticket_attachments')
        .delete()
        .eq('id', row.id);
      throw new ServiceUnavailableException(
        `Storage bucket not ready: ${(err as Error).message}`,
      );
    }

    return {
      attachmentId: row.id as string,
      bucket,
      storagePath,
      uploadUrl,
      token,
    };
  }

  @Post(':id/attachments/:attachmentId/confirm')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmAttachmentUpload(
    @CurrentCompany() companyId: string,
    @Param('id') ticketId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<void> {
    const enabled = await this.features.isEnabled(
      companyId,
      'support_ticket_attachments',
    );
    if (!enabled) {
      throw new ServiceUnavailableException(
        'Attachments uploads are not enabled for this tenant',
      );
    }
    const ticket = await this.assertTicketBelongsToTenant(ticketId, companyId);
    if (!ticket) throw new NotFoundException('Ticket not found');

    const { error } = await this.supabase
      .from('support_ticket_attachments')
      .update({ uploaded_at: new Date().toISOString() })
      .eq('id', attachmentId)
      .eq('ticket_id', ticketId);
    if (error) throw new BadRequestException(error.message);
  }

  private async assertTicketBelongsToTenant(
    ticketId: string,
    companyId: string,
  ): Promise<{ id: string } | null> {
    const { data, error } = await this.supabase
      .from('support_tickets')
      .select('id, company_id')
      .eq('id', ticketId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) return null;
    if (data.company_id !== companyId) {
      throw new ForbiddenException('Ticket does not belong to this tenant');
    }
    return { id: data.id as string };
  }

  private toRow(
    r: Record<string, unknown>,
    attachmentCount: number,
  ): SupportTicketRow {
    return {
      id: r.id as string,
      companyId: r.company_id as string,
      reporterEmployeeId: (r.reporter_employee_id as string | null) ?? null,
      reporterEmail: (r.reporter_email as string | null) ?? null,
      title: r.title as string,
      description: r.description as string,
      severity: r.severity as Severity,
      area: r.area as Area,
      status: r.status as TicketStatus,
      resolution: (r.resolution as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      clientContext:
        (r.client_context as Record<string, unknown> | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      attachmentCount,
    };
  }
}

function cryptoRandomId(): string {
  // 12 hex chars, suficiente para filenames únicos por ticket (escala
  // billions of attachments per ticket sin colisiones prácticas).
  const buf = new Uint8Array(6);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
