import { SetMetadata } from '@nestjs/common';

export const ALLOW_EXPIRED_TRIAL_KEY = 'allowExpiredTrial';

/**
 * Marca un endpoint como exento del `TrialGuard`. Necesario para:
 *   - /auth/me — el user debe poder ver su propio estado de trial
 *   - /onboarding/* — el owner debe poder completar el wizard incluso
 *     con trial vencido (cosa rara, pero defensiva)
 *   - futuros /billing/* — donde el user paga para reactivar
 *
 * NO usar como decorador catch-all: el resto de los endpoints SÍ
 * deben bloquearse cuando el trial expira sin suscripción.
 */
export const AllowExpiredTrial = () =>
  SetMetadata(ALLOW_EXPIRED_TRIAL_KEY, true);
