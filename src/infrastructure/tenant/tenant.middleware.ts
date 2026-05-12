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
    // Estrategia 1: header explícito (para llamadas internas/tests + DEV bypass)
    const headerTenantId = req.headers['x-company-id'] as string | undefined;

    // Estrategia 2: JWT claims (si AuthGuard ya corrió y populó req.auth)
    // Express middleware se ejecuta ANTES que los NestJS guards, así que
    // típicamente req.auth está undefined acá. Lo dejamos como fallback
    // por si algún día se invierte el orden.
    const jwtTenantId =
      ((req as any).auth?.companyId as string | undefined) ??
      ((req as any).user?.company_id as string | undefined);

    const tenantId = jwtTenantId ?? headerTenantId;

    if (tenantId) {
      this.tenantContext.set(tenantId);
    } else if (req.headers.authorization?.startsWith('Bearer ')) {
      // Hay JWT presente — el SupabaseAuthGuard lo va a validar y
      // populará req.auth.companyId. El TenantContext lo seteará otro
      // componente (futuro: interceptor post-guard); mientras tanto los
      // controllers consumen el companyId via @CurrentCompany() del JWT.
      // No throw — dejamos pasar y el guard decide.
    } else {
      throw new UnauthorizedException(
        'Missing tenant identifier: provide X-Company-Id header or a valid JWT with company_id',
      );
    }
    next();
  }
}
