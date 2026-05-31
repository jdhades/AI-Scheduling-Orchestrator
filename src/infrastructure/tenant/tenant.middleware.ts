import {
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * TenantMiddleware
 *
 * Garantiza que las rutas autenticadas llegan al SupabaseAuthGuard con
 * un JWT válido. NO inyecta nada en TenantContext desde el header
 * `X-Company-Id` en producción — confiar en ese header sería permitir
 * cross-tenant attacks (cualquier authed user podría mandar el header
 * del tenant de otra empresa).
 *
 * El companyId siempre se deriva del JWT validado por el guard y se
 * expone via `@CurrentCompany()` en cada controller. El TenantContext
 * (scope REQUEST) queda para casos donde un consumer downstream sin
 * acceso al request HTTP necesita el companyId — se popula
 * explícitamente desde el controller, no acá.
 *
 * En desarrollo/test mantenemos el fallback al header con warning para
 * no romper tests legacy que no autenticaban contra Supabase.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);
  private readonly isProd: boolean;

  constructor(config: ConfigService) {
    const env = (
      config.get<string>('APP_ENV') ??
      config.get<string>('NODE_ENV') ??
      'development'
    ).toLowerCase();
    this.isProd = env === 'production' || env === 'staging';
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    if (req.headers.authorization?.startsWith('Bearer ')) {
      // JWT presente — el SupabaseAuthGuard valida y popula
      // req.auth.companyId. Los controllers usan @CurrentCompany() del
      // JWT, no necesitamos tocar TenantContext acá.
      return next();
    }

    if (this.isProd) {
      throw new UnauthorizedException(
        'Missing JWT: provide a valid Authorization Bearer token',
      );
    }

    // Dev/test: aceptamos X-Company-Id como fallback con warning para
    // no romper tests legacy. NO setea TenantContext — los controllers
    // siguen usando @CurrentCompany() (que viene del guard con bypass
    // si DEV_AUTH_BYPASS=true) y el resto se mantiene igual.
    if (req.headers['x-company-id']) {
      this.logger.warn(
        '[DEV] Request without JWT but with X-Company-Id — only allowed outside prod',
      );
      return next();
    }

    throw new UnauthorizedException(
      'Missing tenant identifier: provide a valid JWT',
    );
  }
}
