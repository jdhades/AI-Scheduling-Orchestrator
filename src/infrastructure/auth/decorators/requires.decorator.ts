import { SetMetadata } from '@nestjs/common';
import type { Capability } from '../../../domain/capabilities/catalog';

export const REQUIRES_KEY = 'requiresCapabilities';

/**
 * Marca un controller/handler como requerido para ciertas capabilities.
 * `CapabilityGuard` lo lee y devuelve 403 si el caller no tiene TODAS
 * las capabilities listadas (AND, no OR).
 *
 * Uso:
 *   @Requires('billing:manage')
 *   @Post('checkout')
 *
 *   @Requires('schedule:write')      ← AND
 *   @Requires('schedule:generate')   ← AND (ambas anotaciones se mergean)
 *
 * Capabilities que requieren scope check del recurso (definidas en
 * SCOPED_CAPABILITIES del catalog) deberían además recibir un check
 * de scope en el controller — typically via @CurrentUser() y un service
 * helper `assertInScope(user, deptId)`.
 *
 * Sin `@Requires`, el guard pasa-through (cualquier auth válida pasa).
 */
export const Requires = (...caps: Capability[]) =>
  SetMetadata(REQUIRES_KEY, caps);
