import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    // DEV bypass: cuando DEV_AUTH_BYPASS=true y la request trae X-Company-Id
    // (el patrón "internal/tests" que ya documenta TenantMiddleware), saltamos
    // la verificación JWT. Deuda HIGH conocida — se quita cuando exista login real.
    if (
      process.env.DEV_AUTH_BYPASS === 'true' &&
      request.headers['x-company-id']
    ) {
      request.user = { company_id: request.headers['x-company-id'] };
      return true;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.split(' ')[1];

    // Verificamos el token criptográficamente contra Supabase
    const {
      data: { user },
      error,
    } = await this.supabase.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException(
        `Invalid JWT token: ${error?.message || 'User not found'}`,
      );
    }

    // Inyectamos el usuario decodificado para TenantMiddleware y los controladores
    request.user = user;

    // Supabase JWTs usually put custom claims in app_metadata or user_metadata
    if (!request.user.company_id && user.app_metadata?.company_id) {
      request.user.company_id = user.app_metadata.company_id;
    }

    if (!request.user.company_id && user.user_metadata?.company_id) {
      request.user.company_id = user.user_metadata.company_id;
    }

    return true;
  }
}
