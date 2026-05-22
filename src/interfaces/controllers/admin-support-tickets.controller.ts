import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import type {
  SupportTicketRow,
  TicketStatus,
} from './support-tickets.controller';

export interface AdminSupportTicketRow extends SupportTicketRow {
  companyName: string | null;
}

class UpdateTicketDto {
  @IsOptional()
  @IsIn(['open', 'in_progress', 'resolved', 'closed'])
  status?: TicketStatus;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  resolution?: string;
}

/**
 * AdminSupportTicketsController — cross-tenant view + workflow.
 *
 *   GET   /admin/support-tickets               → list (filter by status)
 *   GET   /admin/support-tickets/:id           → detail
 *   PATCH /admin/support-tickets/:id           → update status / resolution
 */
@Controller('admin/support-tickets')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminSupportTicketsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  async list(
    @Query('status') status?: TicketStatus,
  ): Promise<AdminSupportTicketRow[]> {
    let query = this.supabase
      .from('support_tickets')
      .select(
        '*, support_ticket_attachments(count), companies!inner(name)',
      )
      .order('created_at', { ascending: false })
      .limit(200);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => {
      const attachments = (r.support_ticket_attachments ?? []) as Array<{
        count: number;
      }>;
      const company = (r.companies ?? null) as { name: string | null } | null;
      return this.toRow(r, attachments[0]?.count ?? 0, company?.name ?? null);
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<AdminSupportTicketRow> {
    const { data, error } = await this.supabase
      .from('support_tickets')
      .select('*, support_ticket_attachments(*), companies(name)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Ticket not found');
    const attachments = (data.support_ticket_attachments ?? []) as Array<{
      count: number;
    }>;
    const company = (data.companies ?? null) as { name: string | null } | null;
    return this.toRow(data, attachments.length, company?.name ?? null);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentUser() admin: AuthContext,
    @Param('id') id: string,
    @Body() body: UpdateTicketDto,
  ): Promise<AdminSupportTicketRow> {
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.status !== undefined) {
      update.status = body.status;
      if (body.status === 'resolved' || body.status === 'closed') {
        update.resolved_at = new Date().toISOString();
        update.resolved_by_auth_user_id = admin.userId;
      } else {
        update.resolved_at = null;
        update.resolved_by_auth_user_id = null;
      }
    }
    if (body.resolution !== undefined) {
      update.resolution = body.resolution || null;
    }

    const { data, error } = await this.supabase
      .from('support_tickets')
      .update(update)
      .eq('id', id)
      .select(
        '*, support_ticket_attachments(count), companies(name)',
      )
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Ticket not found');
    const attachments = (data.support_ticket_attachments ?? []) as Array<{
      count: number;
    }>;
    const company = (data.companies ?? null) as { name: string | null } | null;
    return this.toRow(data, attachments[0]?.count ?? 0, company?.name ?? null);
  }

  private toRow(
    r: Record<string, unknown>,
    attachmentCount: number,
    companyName: string | null,
  ): AdminSupportTicketRow {
    return {
      id: r.id as string,
      companyId: r.company_id as string,
      companyName,
      reporterEmployeeId: (r.reporter_employee_id as string | null) ?? null,
      reporterEmail: (r.reporter_email as string | null) ?? null,
      title: r.title as string,
      description: r.description as string,
      severity: r.severity as SupportTicketRow['severity'],
      area: r.area as SupportTicketRow['area'],
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
