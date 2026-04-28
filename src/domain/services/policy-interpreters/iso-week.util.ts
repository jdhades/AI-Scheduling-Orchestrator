/**
 * Helpers para trabajar con ISO weeks (lunes-domingo, ISO 8601).
 * Lo necesitamos en interpreters que cuentan días por semana
 * (MIN_REST_DAYS_PER_WEEK, MAX_HOURS_PER_WEEK, etc.).
 *
 * Implementación inlined para evitar pulling de date-fns u otra
 * dependencia pesada dentro del dominio.
 */

/** Devuelve la fecha (YYYY-MM-DD) del lunes de la ISO-week que contiene `d`. */
export function isoWeekMonday(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: 1 (lunes) ... 7 (domingo)
  const dayOfWeek = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - dayOfWeek + 1);
  return utc.toISOString().slice(0, 10);
}

/**
 * Clave de ISO week como "YYYY-Www" (ej. "2026-W17"). Útil como key en
 * Maps cuando agrupamos shifts por semana sin importar el año.
 */
export function isoWeekKey(d: Date): string {
  // Algoritmo estándar: encontrar el jueves de la semana y tomar su año.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** ISO date (YYYY-MM-DD) en UTC, ignorando la hora. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
