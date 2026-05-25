import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Roles } from '../../infrastructure/auth/decorators/roles.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import { StripeService } from '../../infrastructure/stripe/stripe.service';

/**
 * BillingController
 *
 *   POST /billing/checkout         → owner inicia checkout
 *   POST /billing/portal           → owner abre Customer Portal (manage sub)
 *   POST /billing/admin/checkout   → platform admin genera checkout link
 *                                    para una company target (Send link)
 *
 * @AllowExpiredTrial a nivel controller — el owner con trial expirado
 * DEBE poder llegar a /checkout o queda atrapado fuera del producto.
 */
export class CreateCheckoutDto {
  @IsIn(['starter', 'growth'])
  tier!: 'starter' | 'growth';
}

export class AdminCheckoutDto {
  @IsUUID('loose')
  companyId!: string;

  @IsIn(['starter', 'growth'])
  tier!: 'starter' | 'growth';

  /** Opcional — si se omite, usa el default success URL del backend. */
  @IsOptional()
  successUrl?: string;

  @IsOptional()
  cancelUrl?: string;
}

@Controller('billing')
@AllowExpiredTrial()
export class BillingController {
  constructor(
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /**
   * POST /billing/checkout — owner-only. Crea Customer si no existe;
   * genera Checkout Session para la company del caller; devuelve URL.
   */
  @Post('checkout')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  async createCheckout(
    @CurrentUser() user: AuthContext,
    @Body() body: CreateCheckoutDto,
  ): Promise<{ url: string }> {
    const url = await this.createCheckoutForCompany(user.companyId, body.tier);
    return { url };
  }

  /**
   * POST /billing/portal — owner-only. Crea Customer Portal session.
   * El portal de Stripe ofrece: cambiar payment method, cancelar/pausar
   * subscription, ver invoices, actualizar billing email.
   */
  @Post('portal')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  async createPortal(
    @CurrentUser() user: AuthContext,
  ): Promise<{ url: string }> {
    const { data: company, error } = await this.supabase
      .from('companies')
      .select('stripe_customer_id')
      .eq('id', user.companyId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!company?.stripe_customer_id) {
      throw new BadRequestException(
        'No Stripe customer for this company — complete a checkout first',
      );
    }

    const session = await this.stripe
      .getClient()
      .billingPortal.sessions.create({
        customer: company.stripe_customer_id,
        return_url: this.buildAppUrl('/'),
      });
    return { url: session.url };
  }

  /**
   * POST /billing/admin/checkout — platform admin genera checkout link
   * para enviarle a una company target (ej. cuando hacen pago manual
   * por wire transfer pero querés que terminen el setup via Stripe).
   */
  @Post('admin/checkout')
  @PlatformAdmin()
  @HttpCode(HttpStatus.OK)
  async adminCreateCheckout(
    @Body() body: AdminCheckoutDto,
  ): Promise<{ url: string }> {
    const url = await this.createCheckoutForCompany(body.companyId, body.tier, {
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
    });
    return { url };
  }

  /**
   * Crea (o reusa) el Customer en Stripe + Checkout Session.
   * Idempotente: si la company ya tiene stripe_customer_id, lo reusa.
   */
  private async createCheckoutForCompany(
    companyId: string,
    tier: 'starter' | 'growth',
    overrides: { successUrl?: string; cancelUrl?: string } = {},
  ): Promise<string> {
    const { data: company, error } = await this.supabase
      .from('companies')
      .select('id, name, stripe_customer_id')
      .eq('id', companyId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!company) throw new NotFoundException('Company not found');

    let customerId = company.stripe_customer_id as string | null;

    if (!customerId) {
      // Buscar el email del owner para asignarlo al Customer.
      const { data: owner } = await this.supabase
        .from('employees')
        .select('auth_user_id')
        .eq('company_id', companyId)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle();
      let email: string | undefined;
      if (owner?.auth_user_id) {
        const { data } = await this.supabase.auth.admin.getUserById(
          owner.auth_user_id,
        );
        email = data.user?.email ?? undefined;
      }

      const customer = await this.stripe.getClient().customers.create({
        email,
        name: company.name ?? undefined,
        metadata: { company_id: companyId },
      });
      customerId = customer.id;

      // Persistimos antes de crear la Checkout Session por si el
      // webhook llega antes que el redirect — evita race condition.
      await this.supabase
        .from('companies')
        .update({ stripe_customer_id: customerId })
        .eq('id', companyId);
    }

    const priceId = this.stripe.resolvePriceId(tier);

    const session = await this.stripe.getClient().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // client_reference_id linkea la session con la company en el webhook.
      client_reference_id: companyId,
      success_url: overrides.successUrl ?? this.buildAppUrl('/billing/success'),
      cancel_url: overrides.cancelUrl ?? this.buildAppUrl('/billing/cancel'),
      // Allow promotion codes en checkout — útil para descuentos del
      // tipo "comp 30 days free" sin tener que tocar nada del backend.
      allow_promotion_codes: true,
    });

    if (!session.url) {
      throw new Error('Stripe returned a session without url');
    }
    return session.url;
  }

  /** Construye URL absoluta para success/cancel/return URLs. */
  private buildAppUrl(path: string): string {
    const base =
      this.config.get<string>('APP_URL') ??
      this.config.get<string>('FRONTEND_URL') ??
      'http://localhost:5173';
    return `${base.replace(/\/$/, '')}${path}`;
  }
}
