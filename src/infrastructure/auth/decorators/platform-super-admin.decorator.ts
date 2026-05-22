import { SetMetadata } from '@nestjs/common';

export const PLATFORM_SUPER_ADMIN_KEY = 'platformSuperAdmin';

/**
 * Marca un endpoint/controller como restringido a platform_admins con
 * role='super'. El PlatformAdminGuard valida ambos niveles cuando ve
 * este metadata (implica @PlatformAdmin() automáticamente).
 *
 * Usar SOLO para acciones que tocan la lista de platform_admins (alta,
 * baja, promote, demote). El resto del panel se queda con @PlatformAdmin().
 */
export const PlatformSuperAdmin = () =>
  SetMetadata(PLATFORM_SUPER_ADMIN_KEY, true);
