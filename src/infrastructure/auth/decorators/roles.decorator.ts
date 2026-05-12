import { SetMetadata } from '@nestjs/common';

export type AppRole = 'owner' | 'manager' | 'employee';
export const ROLES_KEY = 'roles';

/**
 * Marca un controller/handler como restringido a uno o más roles.
 * `RolesGuard` lo lee y devuelve 403 si el `AuthContext.role` no
 * está en la lista.
 *
 * Uso:
 *   @Roles('owner', 'manager')
 *   @Post()
 *   create(...) { ... }
 *
 * Sin `@Roles`, cualquier rol autenticado pasa (la única validación es
 * que el JWT sea válido — eso lo hace `SupabaseAuthGuard`).
 */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
