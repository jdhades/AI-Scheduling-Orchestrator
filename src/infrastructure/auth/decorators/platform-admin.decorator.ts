import { SetMetadata } from '@nestjs/common';

export const PLATFORM_ADMIN_KEY = 'platformAdmin';

/**
 * Marca un endpoint/controller como requerido para platform admins.
 * El `PlatformAdminGuard` lee el metadata y responde 403 si el caller
 * no está en `platform_admins`. Sin esta annotation el guard no aplica.
 */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN_KEY, true);
