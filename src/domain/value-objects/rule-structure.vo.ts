/**
 * RuleStructure — representación estructurada de una regla semántica.
 *
 * Generada UNA VEZ por un LLM al crear/editar la regla, persistida como JSONB
 * en `semantic_rules.structure`. Permite que el runtime traduzca la regla a
 * constraints concretos ({employeeId, shiftId}) sin hacer NLP en cada
 * generación de schedule.
 */

export type EmployeeMatcher = { type: 'name'; value: string } | { type: 'all' };

/** Canonical English day-of-week values — kept in a single representation in DB. */
export type DayOfWeek =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type DateMatcher =
  | { type: 'iso-date'; value: string } // e.g. "2026-04-25"
  | { type: 'day-of-week'; value: DayOfWeek };

/**
 * Substrings (lowercase) a buscar en `shift_template.name` de forma
 * case-insensitive. Ej. ["apertura", "noche"] bloquearía cualquier template
 * cuyo nombre contenga "apertura" O "noche".
 */
export type ShiftNameMatcher = string;

/**
 * Rango horario explícito. Formato "HH:MM" 24h.
 * Si `end < start`, el rango cruza medianoche (ej. start=22:00, end=06:00).
 * Un slot matchea si su `startTime` cae dentro del rango.
 */
export interface HourRange {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export type RuleIntent =
  | 'block'
  | 'permit-multi-shift'
  | 'preference'
  | 'complex';

export interface RuleStructure {
  intent: RuleIntent;
  employeeMatchers: EmployeeMatcher[];
  dateMatchers: DateMatcher[];
  /**
   * Nombres (substrings) a matchear contra `shift_template.name`. Caso de uso:
   * reglas que referencian el turno por su nombre ("apertura", "cierre").
   */
  shiftNameMatchers?: ShiftNameMatcher[];
  /**
   * Rangos horarios concretos. Caso de uso: reglas que limitan por horas
   * específicas ("no trabajar entre 22 y 6"). NO hay categorías fijas
   * (day/night/morning/afternoon) — el manager expresa el rango explícito.
   */
  hourRangeMatchers?: HourRange[];
  /** Si intent='complex', el LLM explica por qué no pudo descomponerla. */
  complexReason?: string;
}

/**
 * Valida que un objeto cumpla el contrato de RuleStructure.
 * Usado al parsear la respuesta del LLM y al leer del JSONB de Postgres.
 */
export function isValidRuleStructure(value: unknown): value is RuleStructure {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;

  const intents: RuleIntent[] = [
    'block',
    'permit-multi-shift',
    'preference',
    'complex',
  ];
  if (
    typeof v.intent !== 'string' ||
    !intents.includes(v.intent as RuleIntent)
  ) {
    return false;
  }

  if (!Array.isArray(v.employeeMatchers)) return false;
  for (const m of v.employeeMatchers) {
    const mm = m as Record<string, unknown>;
    if (mm?.type === 'all') continue;
    if (mm?.type === 'name' && typeof mm.value === 'string') continue;
    return false;
  }

  if (!Array.isArray(v.dateMatchers)) return false;
  const dayNames: DayOfWeek[] = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ];
  for (const d of v.dateMatchers) {
    const dd = d as Record<string, unknown>;
    if (dd?.type === 'iso-date' && typeof dd.value === 'string') continue;
    if (
      dd?.type === 'day-of-week' &&
      typeof dd.value === 'string' &&
      dayNames.includes(dd.value as DayOfWeek)
    ) {
      continue;
    }
    return false;
  }

  if (v.shiftNameMatchers !== undefined) {
    if (!Array.isArray(v.shiftNameMatchers)) return false;
    for (const s of v.shiftNameMatchers) {
      if (typeof s !== 'string' || s.length === 0) return false;
    }
  }

  if (v.hourRangeMatchers !== undefined) {
    if (!Array.isArray(v.hourRangeMatchers)) return false;
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const r of v.hourRangeMatchers) {
      const rr = r as Record<string, unknown>;
      if (
        typeof rr.start !== 'string' ||
        typeof rr.end !== 'string' ||
        !hhmm.test(rr.start) ||
        !hhmm.test(rr.end)
      ) {
        return false;
      }
    }
  }

  return true;
}
