import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantContext } from './tenant.context';

/**
 * TenantMiddleware
 *
 * Extrae el company_id del request y lo inyecta en TenantContext.
 *
 * Estrategias soportadas (en orden de prioridad):
 *  1. Header X-Company-Id  → para llamadas internas / API keys
 *  2. JWT claim company_id → para llamadas autenticadas de usuarios
 *
 * 💡 Multi-tenant: TODOS los endpoints que accedan a datos de negocio
 *    deben pasar por este middleware. Se aplica globalmente en AppModule.
 *
 * 💡 Por qué no usar el JWT de Supabase directamente:
 *    El backend usa service_role key (bypasa RLS por defecto).
 *    El middleware es nuestra primera línea de tenant isolation.
 *    La RLS en PostgreSQL es la segunda línea (defensa en profundidad).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContext) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    // Estrategia 1: header explícito (para llamadas internas/tests)
    const headerTenantId = req.headers['x-company-id'] as string | undefined;

    // Estrategia 2: JWT claims (cuando AuthGuard procesa el token)
    // El AuthGuard de Supabase adjunta el usuario decodificado al request
    const jwtTenantId = (req as any).user?.company_id as string | undefined;

    // PRIORIDAD: JWT validado DEBE tener precedencia sobre header no confiable
    const tenantId = jwtTenantId ?? headerTenantId;

    if (!tenantId) {
      throw new UnauthorizedException(
        'Missing tenant identifier: provide X-Company-Id header or a valid JWT with company_id',
      );
    }

    this.tenantContext.set(tenantId);
    next();
  }
}
