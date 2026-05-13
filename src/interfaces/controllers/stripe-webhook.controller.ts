import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Public } from '../../infrastructure/auth/decorators/public.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import {
  StripeService,
  type StripeEvent,
  type StripeCheckoutSession,
  type StripeSubscription,
  type StripeInvoice,
} from '../../infrastructure/stripe/stripe.service';

type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/**
 * StripeWebhookController — `POST /webhooks/stripe`.
 *
 * @Public porque Stripe no manda JWT; la autenticación es la firma
 * `stripe-signature` que validamos con `STRIPE_WEBHOOK_SECRET`. Sin
 * eso, la firma falla y rechazamos 400.
 *
 * @AllowExpiredTrial porque este endpoint nunca está asociado a una
 * company del caller — es Stripe llamando.
 *
 * Production:
 *   - Verifica firma con `stripe.webhooks.constructEvent` (no hace
 *     trust del body).
 *   - Idempotency vía tabla `stripe_events`: INSERT ON CONFLICT skips
 *     procesamiento de duplicados (Stripe at-least-once delivery).
 *   - Responde 200 después de persistir el evento Y aplicar el side
 *     effect, no antes. Si algo falla, Stripe retry-eará.
 *   - Limita el handling a un subset de eventos conocidos. Eventos
 *     desconocidos se ack-ean (200) para que Stripe no los retrye.
 *
 * Requiere `rawBody` habilitado en `main.ts` para que la firma
 * matchee — Stripe firma el cuerpo crudo, no el JSON parseado.
 */
@Controller('webhooks/stripe')
@Public()
@AllowExpiredTrial()
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; dedupe?: boolean }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    if (!req.rawBody) {
      throw new BadRequestException(
        'rawBody not available — check main.ts bodyParser config',
      );
    }

    let event: StripeEvent;
    try {
      event = this.stripe.verifyWebhook(req.rawBody, signature);
    } catch (err) {
      this.logger.warn(
        `Webhook signature verification failed: ${(err as Error).message}`,
      );
      throw new BadRequestException('Invalid signature');
    }

    // Idempotency: INSERT, si ya estaba, skip handling.
    const { error: insertErr } = await this.supabase
      .from('stripe_events')
      .insert({
        event_id: event.id,
        event_type: event.type,
        payload: event as unknown as Record<string, unknown>,
      });

    if (insertErr) {
      // 23505 = unique violation → ya procesado, dedupe silencioso.
      if ((insertErr as { code?: string }).code === '23505') {
        this.logger.log(`Skipping duplicate event ${event.id} (${event.type})`);
        return { received: true, dedupe: true };
      }
      // Cualquier otro error → 5xx para que Stripe retrye.
      throw new Error(`Failed to record event: ${insertErr.message}`);
    }

    try {
      await this.applyEvent(event);
    } catch (err) {
      // Si el handler falla DESPUÉS del INSERT, borramos la fila para
      // que el retry de Stripe vuelva a entrar al branch normal en
      // vez del dedupe. Sin esto quedaría stuck con side effect a medias.
      await this.supabase
        .from('stripe_events')
        .delete()
        .eq('event_id', event.id);
      this.logger.error(
        `Handler failed for ${event.type} (${event.id}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }

    return { received: true };
  }

  private async applyEvent(event: StripeEvent): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.onCheckoutCompleted(
          event.data.object as StripeCheckoutSession,
        );
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return this.onSubscriptionChange(
          event.data.object as StripeSubscription,
        );
      case 'customer.subscription.deleted':
        return this.onSubscriptionDeleted(
          event.data.object as StripeSubscription,
        );
      case 'invoice.payment_failed':
        return this.onInvoiceFailed(event.data.object as StripeInvoice);
      default:
        // Eventos no manejados se ackean para que Stripe no los retrye.
        // El INSERT en stripe_events sirve de log para debugging.
        this.logger.debug(`Unhandled event type: ${event.type}`);
    }
  }

  private async onCheckoutCompleted(
    session: StripeCheckoutSession,
  ): Promise<void> {
    // `client_reference_id` lo seteamos en /billing/checkout = company_id.
    const companyId = session.client_reference_id;
    if (!companyId) {
      this.logger.warn(
        `Checkout session ${session.id} sin client_reference_id — skip`,
      );
      return;
    }
    const customerId =
      typeof session.customer === 'string' ? session.customer : null;
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : null;

    const update: Record<string, unknown> = {};
    if (customerId) update.stripe_customer_id = customerId;
    if (subscriptionId) update.stripe_subscription_id = subscriptionId;
    // El status real lo confirma `customer.subscription.created` que viene
    // inmediatamente después. Por las dudas, marcamos 'active' acá también
    // — si el subscription event reordena después, sobreescribe.
    if (subscriptionId) update.subscription_status = 'active';

    if (Object.keys(update).length === 0) return;
    const { error } = await this.supabase
      .from('companies')
      .update(update)
      .eq('id', companyId);
    if (error) throw new Error(error.message);
    this.logger.log(
      `Checkout completed for company=${companyId} subscription=${subscriptionId}`,
    );
  }

  private async onSubscriptionChange(
    sub: StripeSubscription,
  ): Promise<void> {
    const status = this.mapStripeStatus(sub.status);
    const customerId = typeof sub.customer === 'string' ? sub.customer : null;
    if (!customerId) return;

    const periodEnd: number | null = this.extractCurrentPeriodEnd(sub);

    const priceId = sub.items.data[0]?.price?.id ?? null;

    const update: Record<string, unknown> = {
      stripe_subscription_id: sub.id,
      subscription_status: status,
      stripe_price_id: priceId,
      current_period_end: periodEnd
        ? new Date(periodEnd * 1000).toISOString()
        : null,
    };

    const { error, count } = await this.supabase
      .from('companies')
      .update(update, { count: 'exact' })
      .eq('stripe_customer_id', customerId);
    if (error) throw new Error(error.message);
    if (count === 0) {
      this.logger.warn(
        `Subscription event for customer=${customerId} pero no matchea ninguna company`,
      );
    }
  }

  private async onSubscriptionDeleted(sub: StripeSubscription): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : null;
    if (!customerId) return;
    const { error } = await this.supabase
      .from('companies')
      .update({ subscription_status: 'canceled' })
      .eq('stripe_customer_id', customerId);
    if (error) throw new Error(error.message);
  }

  private async onInvoiceFailed(invoice: StripeInvoice): Promise<void> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : null;
    if (!customerId) return;
    // Pasamos a past_due (no canceled todavía — Stripe da grace period
    // antes de cancelar el sub). El user sigue viendo la app pero el
    // TrialBanner muestra un warning que se renderice cuando se conecte
    // 'past_due' al UI.
    await this.supabase
      .from('companies')
      .update({ subscription_status: 'past_due' })
      .eq('stripe_customer_id', customerId);
  }

  private mapStripeStatus(s: StripeSubscription['status']): SubscriptionStatus {
    switch (s) {
      case 'active':
      case 'trialing':
        return 'active';
      case 'past_due':
      case 'unpaid':
        return 'past_due';
      case 'canceled':
      case 'incomplete_expired':
        return 'canceled';
      case 'incomplete':
      case 'paused':
      default:
        return 'past_due';
    }
  }

  /**
   * `current_period_end` puede estar en el root del Subscription O en
   * cada subscription item, según versión de la API y plan. Buscamos
   * en ambos lugares.
   */
  private extractCurrentPeriodEnd(sub: StripeSubscription): number | null {
    const subAny = sub as unknown as { current_period_end?: number };
    if (typeof subAny.current_period_end === 'number') {
      return subAny.current_period_end;
    }
    const first = sub.items.data[0] as unknown as {
      current_period_end?: number;
    } | undefined;
    return first?.current_period_end ?? null;
  }
}
