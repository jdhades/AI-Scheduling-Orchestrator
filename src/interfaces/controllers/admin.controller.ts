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
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';

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

/**
 * DTO para asignar el LLM activo de un tenant. Ambos campos son
 * nullable — null = fallback al env-wide.
 *
 * `provider=null` implica `model=null` (no tiene sentido fijar modelo
 * sin provider). El handler valida esa coherencia.
 */
export class UpdateLlmConfigDto {
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['qwen', 'gemini', 'local'])
  provider!: 'qwen' | 'gemini' | 'local' | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  model?: string | null;
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

interface AdminCompanyDetail extends AdminCompanyRow {
  llmProvider: 'qwen' | 'gemini' | 'local' | null;
  llmModel: string | null;
  defaultMaxHoursPerDay: number | null;
  defaultMaxHoursPerWeek: number | null;
}

export class UpdateWorkingTimeDefaultsDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  @Min(0.01)
  @Max(24)
  maxHoursPerDay!: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  @Min(0.01)
  @Max(168)
  maxHoursPerWeek!: number | null;
}

@Controller('admin')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly companyPreferences: CompanyPreferencesService,
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
          ? (c.employees[0].count ?? 0)
          : 0,
    }));
  }

  @Get('companies/:id')
  async getCompany(@Param('id') id: string): Promise<AdminCompanyDetail> {
    const { data, error } = await this.supabase
      .from('companies')
      .select(
        'id, name, created_via, subscription_status, trial_ends_at, onboarded_at, created_at, llm_provider, llm_model, default_max_hours_per_day, default_max_hours_per_week, employees(count)',
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
          ? (data.employees[0].count ?? 0)
          : 0,
      llmProvider:
        (data.llm_provider as AdminCompanyDetail['llmProvider']) ?? null,
      llmModel: (data.llm_model as string | null) ?? null,
      defaultMaxHoursPerDay: numOrNull(data.default_max_hours_per_day),
      defaultMaxHoursPerWeek: numOrNull(data.default_max_hours_per_week),
    };
  }

  /**
   * PATCH /admin/companies/:id/working-time-defaults
   *
   * Setea (o limpia, pasando null) los caps tenant-wide de hours/day y
   * hours/week. El WorkingTimePolicyResolver los usa como fallback cuando
   * no hay override de empleado/depto.
   */
  @Patch('companies/:id/working-time-defaults')
  @HttpCode(HttpStatus.OK)
  async updateWorkingTimeDefaults(
    @Param('id') id: string,
    @Body() body: UpdateWorkingTimeDefaultsDto,
  ): Promise<{
    id: string;
    defaultMaxHoursPerDay: number | null;
    defaultMaxHoursPerWeek: number | null;
  }> {
    const { data, error } = await this.supabase
      .from('companies')
      .update({
        default_max_hours_per_day: body.maxHoursPerDay,
        default_max_hours_per_week: body.maxHoursPerWeek,
      })
      .eq('id', id)
      .select('id, default_max_hours_per_day, default_max_hours_per_week')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Company not found');

    // El resolver lee el cap del DB cada vez (no cache propio).
    this.companyPreferences.invalidate(id);

    return {
      id: data.id as string,
      defaultMaxHoursPerDay: numOrNull(data.default_max_hours_per_day),
      defaultMaxHoursPerWeek: numOrNull(data.default_max_hours_per_week),
    };
  }

  @Patch('companies/:id/subscription')
  @HttpCode(HttpStatus.OK)
  async updateSubscription(
    @Param('id') id: string,
    @Body() body: UpdateSubscriptionDto,
  ): Promise<{
    id: string;
    subscriptionStatus: string;
    trialEndsAt: string | null;
  }> {
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

  /**
   * PATCH /admin/companies/:id/llm-config
   *
   * Asigna provider + model que usa el tenant. null en provider = el
   * tenant cae al env-wide. Invalidamos el cache de CompanyPreferences
   * para que la próxima llamada lea el valor nuevo.
   */
  @Patch('companies/:id/llm-config')
  @HttpCode(HttpStatus.OK)
  async updateLlmConfig(
    @Param('id') id: string,
    @Body() body: UpdateLlmConfigDto,
  ): Promise<{
    id: string;
    llmProvider: string | null;
    llmModel: string | null;
  }> {
    // Si provider es null, model también debe ser null (coherencia).
    const provider = body.provider ?? null;
    const model = provider ? (body.model ?? null) : null;

    const { data, error } = await this.supabase
      .from('companies')
      .update({ llm_provider: provider, llm_model: model })
      .eq('id', id)
      .select('id, llm_provider, llm_model')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Company not found');

    this.companyPreferences.invalidate(id);

    return {
      id: data.id as string,
      llmProvider: (data.llm_provider as string | null) ?? null,
      llmModel: (data.llm_model as string | null) ?? null,
    };
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
