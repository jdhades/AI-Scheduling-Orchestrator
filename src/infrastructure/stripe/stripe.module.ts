import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StripeService } from './stripe.service';

/**
 * StripeModule — global, expone StripeService. Cualquier controller que
 * necesite Stripe (BillingController, StripeWebhookController, panel
 * admin con acciones Stripe) lo inyecta directo.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
