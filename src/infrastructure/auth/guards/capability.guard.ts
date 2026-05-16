import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REQUIRES_KEY } from '../decorators/requires.decorator';
import type { AuthContext } from '../auth-context';
import type { Capability } from '../../../domain/capabilities/catalog';

/**
 * CapabilityGuard — corre después de SupabaseAuthGuard. Si el endpoint
 * tiene `@Requires(...caps)`, valida que el user tenga TODAS via:
 *   1. company_role_capabilities[user.company][user.role]
 *   2. employee_capabilities[user.employeeId]
 *
 * Sin annotation → pass-through.
 *
 * Performance: 2 queries por request gated. Aceptable porque la mayoría
 * de endpoints chequea 1-2 capabilities y el panel admin es low-traffic.
 * Si se vuelve hot path, cachear por-request en `req.auth.capabilities`.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Capability[]>(
      REQUIRES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = req.auth;
    if (!auth?.companyId || !auth?.role) {
      throw new ForbiddenException(
        'Authentication required for capability-gated endpoint',
      );
    }

    // 1) Capabilities concedidas por el rol del user en esta company.
    const { data: roleCaps, error: roleErr } = await this.supabase
      .from('company_role_capabilities')
      .select('capability')
      .eq('company_id', auth.companyId)
      .eq('role', auth.role)
      .in('capability', required);
    if (roleErr) {
      throw new ForbiddenException(
        `Capability lookup failed: ${roleErr.message}`,
      );
    }
    const grantedByRole = new Set<string>(
      (roleCaps ?? []).map((r: { capability: string }) => r.capability),
    );

    let missing = required.filter((c) => !grantedByRole.has(c));

    // 2) Overrides individuales (sólo si todavía falta algo).
    if (missing.length > 0 && auth.employeeId) {
      const { data: overrides } = await this.supabase
        .from('employee_capabilities')
        .select('capability')
        .eq('employee_id', auth.employeeId)
        .in('capability', missing);
      const grantedByOverride = new Set<string>(
        (overrides ?? []).map((r: { capability: string }) => r.capability),
      );
      missing = missing.filter((c) => !grantedByOverride.has(c));
    }

    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing capabilities: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
