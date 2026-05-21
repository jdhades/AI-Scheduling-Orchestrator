/** ISO date (YYYY-MM-DD) en UTC, ignorando la hora. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
