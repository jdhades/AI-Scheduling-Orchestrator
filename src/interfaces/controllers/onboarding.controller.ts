import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Roles } from '../../infrastructure/auth/decorators/roles.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

/**
 * Wizard del owner post-signup. Persiste estado entre pasos para que
 * el user pueda cerrar la pestaña y retomar; finaliza aplicando los
 * datos a `companies` y marcando `onboarded_at`.
 *
 *   GET   /onboarding/draft     → state actual (owner-only)
 *   PATCH /onboarding/draft     → upsert con step + data parcial
 *   POST  /onboarding/complete  → finaliza, aplica al tenant, marca onboarded_at
 */
export class UpsertDraftDto {
  @IsInt()
  @Min(1)
  @Max(6)
  currentStep!: number;

  @IsObject()
  data!: Record<string, unknown>;
}

export class CompleteOnboardingDto {
  /** Final company name del wizard step 2. */
  @IsString()
  @MinLength(1)
  companyName!: string;

  /** Resto del state — se guarda como snapshot en el draft. Los campos
   * que tengan destino propio (futuro: timezone, business_type) los
   * mapeamos acá; el resto queda para analytics posterior. */
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

interface DraftRow {
  companyId: string;
  currentStep: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

@Controller('onboarding')
export class OnboardingController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('draft')
  @Roles('owner')
  async getDraft(@CurrentUser() user: AuthContext): Promise<DraftRow | null> {
    const { data, error } = await this.supabase
      .from('onboarding_drafts')
      .select('company_id, current_step, data, updated_at')
      .eq('company_id', user.companyId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) return null;
    return {
      companyId: data.company_id,
      currentStep: data.current_step,
      data: (data.data ?? {}) as Record<string, unknown>,
      updatedAt: data.updated_at,
    };
  }

  @Patch('draft')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  async upsertDraft(
    @CurrentUser() user: AuthContext,
    @Body() body: UpsertDraftDto,
  ): Promise<DraftRow> {
    const { data, error } = await this.supabase
      .from('onboarding_drafts')
      .upsert(
        {
          company_id: user.companyId,
          current_step: body.currentStep,
          data: body.data,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'company_id' },
      )
      .select('company_id, current_step, data, updated_at')
      .single();
    if (error) throw new BadRequestException(error.message);
    return {
      companyId: data.company_id,
      currentStep: data.current_step,
      data: (data.data ?? {}) as Record<string, unknown>,
      updatedAt: data.updated_at,
    };
  }

  @Post('complete')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentUser() user: AuthContext,
    @Body() body: CompleteOnboardingDto,
  ): Promise<{ onboardedAt: string }> {
    // 1. Validar que la company existe y no esté ya onboarded (idempotente
    //    suave: si reintenta, devolvemos el timestamp anterior sin pisarlo).
    const { data: company, error: cErr } = await this.supabase
      .from('companies')
      .select('id, onboarded_at')
      .eq('id', user.companyId)
      .maybeSingle();
    if (cErr) throw new BadRequestException(cErr.message);
    if (!company) throw new NotFoundException('Company not found');

    if (company.onboarded_at) {
      return { onboardedAt: company.onboarded_at };
    }

    const onboardedAt = new Date().toISOString();

    // 2. Aplicar datos al tenant. Por ahora solo `name` — los otros
    //    campos del wizard (timezone, business_type, scheduling prefs)
    //    se materializarán cuando agreguemos sus columnas/tablas en PRs
    //    siguientes. Snapshot completo queda en onboarding_drafts.
    const { error: uErr } = await this.supabase
      .from('companies')
      .update({ name: body.companyName, onboarded_at: onboardedAt })
      .eq('id', user.companyId);
    if (uErr) throw new BadRequestException(uErr.message);

    // 3. Snapshot del draft final si vino data. No borramos la fila —
    //    sirve de historial.
    if (body.data) {
      await this.supabase
        .from('onboarding_drafts')
        .update({
          data: body.data,
          current_step: 6,
          updated_at: onboardedAt,
        })
        .eq('company_id', user.companyId);
    }

    return { onboardedAt };
  }
}
