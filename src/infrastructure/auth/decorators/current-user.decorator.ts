import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from '../auth-context';

/**
 * Extrae el `AuthContext` completo del request — populated por
 * `SupabaseAuthGuard`. Uso típico en controllers que necesitan el
 * employeeId o role del caller.
 *
 *   @Get('me')
 *   me(@CurrentUser() user: AuthContext) { ... }
 *
 * Si el endpoint está marcado `@Public()`, el guard NO setea `req.auth`
 * y este decorador devuelve `undefined` — los controllers públicos
 * deben evitar usarlo o validar nullish.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined => {
    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    return req.auth;
  },
);
