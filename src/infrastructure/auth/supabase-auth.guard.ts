import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { JwtValidatorService } from './services/jwt-validator.service';
import type { AuthContext } from './auth-context';

/**
 * SupabaseAuthGuard — guard global aplicado vía APP_GUARD en
 * `AuthModule`. Decide en este orden:
 *
 *   1. `@Public()`        → bypassa todo (endpoints abiertos: health, webhooks)
 *   2. `DEV_AUTH_BYPASS`  → modo legacy del sprint actual. Resuelve
 *                          companyId desde el header `X-Company-Id`.
 *                          Se elimina cuando termine PR 5.
 *   3. JWT Bearer         → valida firma local con `JwtValidatorService`
 *                          (JWKS Supabase). Si el JWT trae custom claims
 *                          (company_id, employee_role…) los usa directo.
 *                          Sino, hace lookup contra `employees` por
 *                          `auth_user_id` (path legacy hasta que el
 *                          access token hook esté configurado).
 *
 * Popula `req.auth: AuthContext` para los decoradores `@CurrentUser()`
 * y `@CurrentCompany()`. Esa es la API estable que los controllers
 * consumen — `req.user` queda como alias por compat con código legacy.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly reflector: Reflector,
    private readonly jwtValidator: JwtValidatorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();

    // ─── DEV bypass ───────────────────────────────────────────────
    // X-Company-Id header + flag DEV_AUTH_BYPASS=true + SIN Bearer
    // → bypass del JWT (path para tests/curl/scripts sin sesión).
    //
    // Si hay Bearer, ignoramos el bypass y validamos el JWT real.
    // Sin esta condición, el frontend con sesión Supabase activa
    // también caía en el bypass (porque axios interceptor manda BOTH
    // headers) y `employeeId` quedaba null → /auth/me PATCH rompía.
    //
    // El bypass está protegido por hard-fail en main.ts: si APP_ENV o
    // NODE_ENV son prod-like y DEV_AUTH_BYPASS=true, el server NO
    // arranca (process.exit(1)). Garantiza que esto solo corre en
    // dev/test environments.
    const hasBearer = (request.headers.authorization ?? '').startsWith(
      'Bearer ',
    );
    if (
      process.env.DEV_AUTH_BYPASS === 'true' &&
      request.headers['x-company-id'] &&
      !hasBearer
    ) {
      // Role inferido del header opcional `X-Employee-Role`. Sin él,
      // asumimos 'owner' — el path DEV es para devs/tests que necesitan
      // acceso completo, y owner hereda todo lo de manager. En prod
      // el bypass NO se activa (hard-fail al boot si DEV_AUTH_BYPASS=true
      // con APP_ENV prod-like) → `role` viene del JWT custom claim.
      const headerRole = request.headers['x-employee-role'];
      const role: 'owner' | 'manager' | 'employee' =
        headerRole === 'employee'
          ? 'employee'
          : headerRole === 'manager'
            ? 'manager'
            : 'owner';
      const auth: AuthContext = {
        userId: null,
        employeeId: null,
        companyId: request.headers['x-company-id'],
        role,
        departmentId: null,
      };
      request.auth = auth;
      // Alias para código legacy que lee `req.user`.
      request.user = { company_id: auth.companyId };
      return true;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }
    const token = authHeader.split(' ')[1];

    // ─── Validación JWT local (jose + JWKS) ───────────────────────
    let claims;
    try {
      claims = await this.jwtValidator.verify(token);
    } catch (err) {
      throw new UnauthorizedException(`Invalid JWT: ${(err as Error).message}`);
    }

    // Path A: hook de Supabase ya inyecta custom claims → uso directo.
    if (claims.company_id) {
      const auth: AuthContext = {
        userId: claims.sub,
        employeeId: claims.employee_id ?? null,
        companyId: claims.company_id,
        role: claims.employee_role ?? null,
        departmentId: claims.department_id ?? null,
      };
      request.auth = auth;
      request.user = { id: claims.sub, company_id: auth.companyId };
      return true;
    }

    // Path B: sin hook todavía — lookup en `employees` por auth_user_id.
    // Costo: 1 query por request. Aceptable como bridge hasta que el
    // hook entre (entonces este branch se vuelve dead code).
    const { data: emp, error } = await this.supabase
      .from('employees')
      .select('id, company_id, role, department_id')
      .eq('auth_user_id', claims.sub)
      .maybeSingle();
    if (emp) {
      const auth: AuthContext = {
        userId: claims.sub,
        employeeId: emp.id,
        companyId: emp.company_id,
        role: emp.role,
        departmentId: emp.department_id,
      };
      request.auth = auth;
      request.user = { id: claims.sub, company_id: auth.companyId };
      return true;
    }
    if (error) {
      this.logger.warn(
        `employees lookup failed for user=${claims.sub}: ${error.message}`,
      );
    }

    // Path B2: sin employee linkeado, puede ser un platform_admin
    // (super/support) que opera cross-tenant. No tiene company.
    // Dejamos pasar con companyId='' — los endpoints @PlatformAdmin()
    // no leen companyId; los endpoints de tenant fallarán naturalmente
    // si un platform_admin los toca sin impersonar.
    const { data: pa } = await this.supabase
      .from('platform_admins')
      .select('id')
      .eq('auth_user_id', claims.sub)
      .maybeSingle();
    if (pa) {
      const auth: AuthContext = {
        userId: claims.sub,
        employeeId: null,
        companyId: '',
        role: null,
        departmentId: null,
      };
      request.auth = auth;
      request.user = { id: claims.sub, company_id: auth.companyId };
      return true;
    }

    this.logger.warn(
      `JWT válido pero no linked a employee ni platform_admin — user=${claims.sub}`,
    );
    throw new UnauthorizedException('User not linked to any employee');
  }
}
