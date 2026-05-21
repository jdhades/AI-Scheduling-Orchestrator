import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * StripeService — wraps el SDK con config + bandera de presence.
 *
 * Si STRIPE_SECRET_KEY no está seteada, los endpoints de billing
 * responden 503 "Billing not configured". El service expone
 * `isConfigured()` para que controllers chequeen sin instanciar el SDK.
 *
 * Production-grade:
 *   - apiVersion pinneada al default del SDK (cambiar a una version
 *     más nueva requiere upgrade del paquete completo)
 *   - maxNetworkRetries para tolerar blips transitorios
 *   - typescript: true habilita los typings agresivos
 *
 * Type note: stripe-node v22 no expone los types de Stripe vía
 * namespace directo (el entry `.d.ts` solo re-exporta el constructor).
 * Inferimos los types desde los métodos del SDK con `ReturnType` —
 * patrón robusto que sobrevive a upgrades porque depende del shape
 * público de la API, no de paths internos.
 */
type StripeClient = InstanceType<typeof Stripe>;
export type StripeEvent = ReturnType<StripeClient['webhooks']['constructEvent']>;
export type StripeCheckoutSession = Awaited<
  ReturnType<StripeClient['checkout']['sessions']['retrieve']>
>;
export type StripeSubscription = Awaited<
  ReturnType<StripeClient['subscriptions']['retrieve']>
>;
export type StripeInvoice = Awaited<
  ReturnType<StripeClient['invoices']['retrieve']>
>;

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: StripeClient | null;
  private readonly webhookSecret: string | null;
  private readonly priceStarter: string | null;
  private readonly priceGrowth: string | null;

  constructor(private readonly config: ConfigService) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET') ?? null;
    this.priceStarter =
      this.config.get<string>('STRIPE_PRICE_ID_STARTER') ?? null;
    this.priceGrowth =
      this.config.get<string>('STRIPE_PRICE_ID_GROWTH') ?? null;

    if (!secretKey) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not set — billing endpoints will respond 503',
      );
      this.client = null;
      return;
    }

    this.client = new Stripe(secretKey, {
      typescript: true,
      maxNetworkRetries: 2,
      telemetry: false,
    });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getClient(): StripeClient {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Billing not configured — STRIPE_SECRET_KEY missing',
      );
    }
    return this.client;
  }

  getWebhookSecret(): string {
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException(
        'Billing not configured — STRIPE_WEBHOOK_SECRET missing',
      );
    }
    return this.webhookSecret;
  }

  /**
   * Inverso de `resolvePriceId`: dado un price_id, devuelve el nombre del
   * tier que matchea, o null si no es uno de los configurados. Útil para
   * el panel admin que necesita mostrar tier a partir del price_id del
   * tenant.
   */
  resolveTierFromPriceId(priceId: string | null): 'starter' | 'growth' | null {
    if (!priceId) return null;
    if (priceId === this.priceStarter) return 'starter';
    if (priceId === this.priceGrowth) return 'growth';
    return null;
  }

  /**
   * Snapshot del catálogo configurado. Cada entry tiene tier + priceId.
   * Si una variable de entorno falta, el entry queda con priceId=null.
   */
  getConfiguredPlans(): Array<{ tier: 'starter' | 'growth'; priceId: string | null }> {
    return [
      { tier: 'starter', priceId: this.priceStarter },
      { tier: 'growth', priceId: this.priceGrowth },
    ];
  }

  /**
   * Resuelve el price_id desde un nombre de tier ('starter' | 'growth').
   * Throw si el price no está configurado.
   */
  resolvePriceId(tier: 'starter' | 'growth'): string {
    const priceId = tier === 'starter' ? this.priceStarter : this.priceGrowth;
    if (!priceId) {
      throw new ServiceUnavailableException(
        `Billing not configured — STRIPE_PRICE_ID_${tier.toUpperCase()} missing`,
      );
    }
    return priceId;
  }

  /** Verifica la firma del webhook con `STRIPE_WEBHOOK_SECRET`. */
  verifyWebhook(rawBody: Buffer, signature: string): StripeEvent {
    return this.getClient().webhooks.constructEvent(
      rawBody,
      signature,
      this.getWebhookSecret(),
    );
  }
}
