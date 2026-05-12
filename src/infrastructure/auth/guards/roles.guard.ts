import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES_KEY, type AppRole } from '../decorators/roles.decorator';
import type { AuthContext } from '../auth-context';

/**
 * RolesGuard — corre DESPUÉS de `SupabaseAuthGuard` (asegurado por
 * el orden global de registración en AppModule). Lee el array `roles`
 * del metadata, comparado contra `req.auth.role`.
 *
 * Si no hay `@Roles()` declarados → permite (cualquier autenticado).
 * Si hay y `req.auth.role` no está en la lista → 403.
 * Si `req.auth` es undefined (endpoint @Public) → permite (no es
 * pelea de RolesGuard validar auth — eso ya pasó arriba).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Supabase opcional — durante boot temprano (algunos tests) puede
    // no estar listo aún; el guard funciona sin él (skip audit).
    @Optional()
    @Inject('SUPABASE_CLIENT')
    private readonly supabase?: SupabaseClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{
      auth?: AuthContext;
      method?: string;
      url?: string;
      ip?: string;
      headers?: Record<string, string>;
    }>();
    const role = req.auth?.role;

    if (!role || !required.includes(role)) {
      // PR 12 — audit del 403. Fire-and-forget; no rompe el flow.
      void this.recordDenied(req, required.join('|'));
      if (!role) {
        throw new ForbiddenException(
          'Authentication required for role-gated endpoint',
        );
      }
      throw new ForbiddenException(
        `Role '${role}' not in allowed list [${required.join(', ')}]`,
      );
    }
    return true;
  }

  private async recordDenied(
    req: {
      auth?: AuthContext;
      method?: string;
      url?: string;
      ip?: string;
      headers?: Record<string, string>;
    },
    requiredRoles: string,
  ): Promise<void> {
    if (!this.supabase) return;
    try {
      await this.supabase.from('auth_audit_log').insert({
        company_id: req.auth?.companyId ?? null,
        auth_user_id: req.auth?.userId ?? null,
        employee_id: req.auth?.employeeId ?? null,
        event: 'permission_denied',
        ip_address: req.ip ?? null,
        user_agent: req.headers?.['user-agent'] ?? null,
        metadata: {
          method: req.method,
          path: req.url,
          requiredRoles,
          actualRole: req.auth?.role ?? null,
        },
      });
    } catch {
      // silent — auditing nunca debe bloquear el response al user.
    }
  }
}
