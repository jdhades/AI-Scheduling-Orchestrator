import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const role = req.auth?.role;
    if (!role) {
      // Sin auth resuelto pero hay @Roles — el endpoint pidió rol pero
      // no se identificó al user. Bloquear (mejor errar restrictivo).
      throw new ForbiddenException('Authentication required for role-gated endpoint');
    }
    if (!required.includes(role)) {
      throw new ForbiddenException(
        `Role '${role}' not in allowed list [${required.join(', ')}]`,
      );
    }
    return true;
  }
}
