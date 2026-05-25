import { Controller, Get, Inject } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { StripeService } from '../../infrastructure/stripe/stripe.service';

export interface PlanSummaryRow {
  tier: 'starter' | 'growth';
  priceId: string | null;
  /** Tenants con stripe_price_id = priceId. */
  subscriberCount: number;
  /** Distribución de subscription_status entre los subscribers. */
  byStatus: {
    trialing: number;
    active: number;
    past_due: number;
    canceled: number;
  };
}

export interface PlansOverview {
  configured: boolean; // false si Stripe no está configurado
  plans: PlanSummaryRow[];
  /** Tenants sin price_id (no completaron checkout aún). */
  unassigned: number;
}

/**
 * AdminPlansController — vista read-only de tiers configurados y cuántos
 * tenants viven en cada uno. Los tiers en sí están en env vars
 * (STRIPE_PRICE_ID_*); este endpoint los expone con headcounts.
 *
 *   GET /admin/plans → overview
 */
@Controller('admin/plans')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminPlansController {
  constructor(
    private readonly stripe: StripeService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  async overview(): Promise<PlansOverview> {
    const plans = this.stripe.getConfiguredPlans();

    const { data, error } = await this.supabase
      .from('companies')
      .select('stripe_price_id, subscription_status');
    if (error) {
      return {
        configured: this.stripe.isConfigured(),
        plans: plans.map((p) => ({
          ...p,
          subscriberCount: 0,
          byStatus: {
            trialing: 0,
            active: 0,
            past_due: 0,
            canceled: 0,
          },
        })),
        unassigned: 0,
      };
    }

    type Status = keyof PlanSummaryRow['byStatus'];
    const KNOWN_STATUSES = new Set<Status>([
      'trialing',
      'active',
      'past_due',
      'canceled',
    ]);

    const summaries = new Map<string | null, PlanSummaryRow>();
    for (const p of plans) {
      summaries.set(p.priceId, {
        tier: p.tier,
        priceId: p.priceId,
        subscriberCount: 0,
        byStatus: { trialing: 0, active: 0, past_due: 0, canceled: 0 },
      });
    }
    let unassigned = 0;

    for (const row of data ?? []) {
      const pid = (row.stripe_price_id as string | null) ?? null;
      const sm = summaries.get(pid);
      if (sm) {
        sm.subscriberCount += 1;
        const status = (row.subscription_status as Status) ?? 'trialing';
        if (KNOWN_STATUSES.has(status)) {
          sm.byStatus[status] += 1;
        }
      } else if (pid === null) {
        unassigned += 1;
      }
      // pid no nulo pero no matchea ningún tier configurado → ignorado.
      // (Caso edge: env vars rotadas dejando rows con price_ids viejos.)
    }

    return {
      configured: this.stripe.isConfigured(),
      plans: Array.from(summaries.values()),
      unassigned,
    };
  }
}
