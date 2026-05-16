import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PLATFORM_ADMIN_KEY } from '../decorators/platform-admin.decorator';
import type { AuthContext } from '../auth-context';

/**
 * PlatformAdminGuard — gating cross-tenant para el panel de operadores
 * de plataforma. Solo se activa si el endpoint/controller tiene
 * `@PlatformAdmin()`. Sin la annotation, este guard deja pasar.
 *
 * Query a `platform_admins` por auth_user_id. ~1ms en PK lookup; sin
 * cache. Si el panel se vuelve hot path, considerar JWT custom claim.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_ADMIN_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = req.auth;
    if (!auth?.userId) {
      throw new ForbiddenException(
        'Platform admin endpoint requires authentication',
      );
    }

    const { data } = await this.supabase
      .from('platform_admins')
      .select('id')
      .eq('auth_user_id', auth.userId)
      .maybeSingle();

    if (!data) {
      throw new ForbiddenException('Platform admin access required');
    }
    return true;
  }
}
