import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ALLOW_EXPIRED_TRIAL_KEY } from '../decorators/allow-expired-trial.decorator';
import type { AuthContext } from '../auth-context';

/**
 * TrialGuard — corre después de SupabaseAuthGuard + RolesGuard.
 *
 * Lógica:
 *   - Sin req.auth (endpoint @Public, no aplica) → permitir.
 *   - Endpoint con @AllowExpiredTrial → permitir.
 *   - Query `companies` para el companyId del caller.
 *     - subscription_status='active' o 'past_due' → permitir.
 *     - subscription_status='trialing' AND trial_ends_at >= now() → permitir.
 *     - subscription_status='trialing' AND trial_ends_at < now() → 402.
 *     - subscription_status='canceled' → 402.
 *
 * Por ahora hace una query por request. Si se vuelve hot path, agregar
 * cache in-memory con TTL o subscription_status al custom JWT claim.
 */
@Injectable()
export class TrialGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const allowExpired = this.reflector.getAllAndOverride<boolean>(
      ALLOW_EXPIRED_TRIAL_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowExpired) return true;

    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = req.auth;
    if (!auth || !auth.companyId) return true; // @Public; no es nuestro problema

    const { data, error } = await this.supabase
      .from('companies')
      .select('subscription_status, trial_ends_at')
      .eq('id', auth.companyId)
      .maybeSingle();

    if (error || !data) {
      // Fail-open: si la query rompe, no bloqueamos. Es peor un guard
      // que mata el sistema por una falla transitoria de Supabase.
      return true;
    }

    const { subscription_status: status, trial_ends_at: trialEndsAt } = data as {
      subscription_status: string;
      trial_ends_at: string | null;
    };

    if (status === 'active' || status === 'past_due') return true;

    if (status === 'trialing') {
      if (!trialEndsAt) return true; // sin deadline = no bloqueamos
      if (new Date(trialEndsAt).getTime() >= Date.now()) return true;
      throw new HttpException(
        {
          errorCode: 'TRIAL_EXPIRED',
          message: 'Trial period expired. Subscribe to continue.',
          trialEndsAt,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (status === 'canceled') {
      throw new HttpException(
        {
          errorCode: 'SUBSCRIPTION_CANCELED',
          message: 'Subscription canceled. Renew to continue.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
