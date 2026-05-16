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
} from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsOptional,
} from 'class-validator';
import { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

/**
 * AdminController — endpoints cross-tenant para platform admins.
 *
 *   GET   /admin/companies         → listado con filtros básicos
 *   GET   /admin/companies/:id     → detalle de una company
 *   PATCH /admin/companies/:id/subscription → setear status / trial
 *
 * @PlatformAdmin() a nivel controller — el guard lee la metadata y
 * cualquier user que no esté en `platform_admins` recibe 403.
 *
 * @AllowExpiredTrial() también a nivel controller — el platform admin
 * puede tener su propia company con trial vencido y aún así operar el
 * panel.
 */
export class UpdateSubscriptionDto {
  @IsIn(['trialing', 'active', 'past_due', 'canceled'])
  subscriptionStatus!: 'trialing' | 'active' | 'past_due' | 'canceled';

  /** Si se pasa, se actualiza también trial_ends_at. Útil para extender
   * el trial de un prospecto sin cambiar status. */
  @IsOptional()
  @IsDateString()
  trialEndsAt?: string;
}

interface AdminCompanyRow {
  id: string;
  name: string | null;
  createdVia: 'sql_seed' | 'self_signup' | 'sales_demo';
  subscriptionStatus: 'trialing' | 'active' | 'past_due' | 'canceled';
  trialEndsAt: string | null;
  onboardedAt: string | null;
  createdAt: string;
  employeeCount: number;
}

@Controller('admin')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('companies')
  async listCompanies(): Promise<AdminCompanyRow[]> {
    // Single query con count agregado. Supabase usa head:false +
    // count param para devolver el count en headers; acá lo derivamos
    // con un join via select string.
    const { data, error } = await this.supabase
      .from('companies')
      .select(
        'id, name, created_via, subscription_status, trial_ends_at, onboarded_at, created_at, employees(count)',
      )
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((c) => ({
      id: c.id as string,
      name: c.name as string | null,
      createdVia: c.created_via as AdminCompanyRow['createdVia'],
      subscriptionStatus:
        c.subscription_status as AdminCompanyRow['subscriptionStatus'],
      trialEndsAt: c.trial_ends_at as string | null,
      onboardedAt: c.onboarded_at as string | null,
      createdAt: c.created_at as string,
      employeeCount:
        Array.isArray(c.employees) && c.employees[0]
          ? ((c.employees[0] as { count: number }).count ?? 0)
          : 0,
    }));
  }

  @Get('companies/:id')
  async getCompany(@Param('id') id: string): Promise<AdminCompanyRow> {
    const { data, error } = await this.supabase
      .from('companies')
      .select(
        'id, name, created_via, subscription_status, trial_ends_at, onboarded_at, created_at, employees(count)',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Company not found');
    return {
      id: data.id as string,
      name: data.name as string | null,
      createdVia: data.created_via as AdminCompanyRow['createdVia'],
      subscriptionStatus:
        data.subscription_status as AdminCompanyRow['subscriptionStatus'],
      trialEndsAt: data.trial_ends_at as string | null,
      onboardedAt: data.onboarded_at as string | null,
      createdAt: data.created_at as string,
      employeeCount:
        Array.isArray(data.employees) && data.employees[0]
          ? ((data.employees[0] as { count: number }).count ?? 0)
          : 0,
    };
  }

  @Patch('companies/:id/subscription')
  @HttpCode(HttpStatus.OK)
  async updateSubscription(
    @Param('id') id: string,
    @Body() body: UpdateSubscriptionDto,
  ): Promise<{ id: string; subscriptionStatus: string; trialEndsAt: string | null }> {
    const update: Record<string, unknown> = {
      subscription_status: body.subscriptionStatus,
    };
    if (body.trialEndsAt) update.trial_ends_at = body.trialEndsAt;

    const { data, error } = await this.supabase
      .from('companies')
      .update(update)
      .eq('id', id)
      .select('id, subscription_status, trial_ends_at')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Company not found');

    return {
      id: data.id as string,
      subscriptionStatus: data.subscription_status as string,
      trialEndsAt: (data.trial_ends_at as string | null) ?? null,
    };
  }
}
