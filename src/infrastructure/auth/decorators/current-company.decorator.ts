import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from '../auth-context';

/**
 * Shortcut para `@CurrentUser().companyId`. La mayoría de los
 * endpoints solo necesitan el tenant — esto evita la indirección.
 *
 *   @Get()
 *   list(@CurrentCompany() companyId: string) { ... }
 *
 * Durante el período de migración, este decorador reemplaza al
 * `@Query('companyId') companyId: string` que tenían los endpoints.
 * El valor viene del JWT (o del bypass) — el caller no puede falsearlo.
 */
export const CurrentCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    return req.auth?.companyId;
  },
);
