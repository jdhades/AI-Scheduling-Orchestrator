export type WeekStartsOn = 'sunday' | 'monday';

/**
 * Devuelve la fecha UTC del primer día de la semana que contiene `d`,
 * según la preferencia del tenant (`weekStartsOn`). Output normalizado
 * a 00:00:00 UTC.
 *
 * Reemplaza al patrón hardcoded `day === 0 ? -6 : 1`, que asumía lunes
 * como inicio de semana y por lo tanto rompía para tenants Sunday-start.
 */
export function weekStartOf(d: Date, weekStartsOn: WeekStartsOn): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const startDow = weekStartsOn === 'sunday' ? 0 : 1;
  const offset = (out.getUTCDay() - startDow + 7) % 7;
  out.setUTCDate(out.getUTCDate() - offset);
  return out;
}

/** Atajo: ISO date (YYYY-MM-DD) del primer día de la semana de `d`. */
export function weekStartIso(d: Date, weekStartsOn: WeekStartsOn): string {
  return weekStartOf(d, weekStartsOn).toISOString().split('T')[0];
}

/**
 * Próxima semana (offset +1) respecto a hoy. Útil para el default de
 * `generate_schedule` cuando el usuario no especifica weekStart.
 */
export function nextWeekStartIso(weekStartsOn: WeekStartsOn): string {
  const today = weekStartOf(new Date(), weekStartsOn);
  today.setUTCDate(today.getUTCDate() + 7);
  return today.toISOString().split('T')[0];
}

/**
 * Clave estable de "semana del tenant" como YYYY-MM-DD del primer día.
 * Reemplaza a `isoWeekKey` cuando el agrupamiento debe respetar la
 * preferencia del tenant (lunes vs domingo) — ej. fairness por semana,
 * counting de rest days, etc.
 *
 * Dos fechas en la misma semana del tenant producen la misma key. La
 * comparación cross-tenant es válida porque la key es la fecha ISO del
 * anchor, no un número de semana relativo a un calendario.
 */
export function companyWeekKey(d: Date, weekStartsOn: WeekStartsOn): string {
  return weekStartIso(d, weekStartsOn);
}
