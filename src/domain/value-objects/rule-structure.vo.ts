/**
 * RuleStructure — representación estructurada de una regla semántica.
 *
 * Generada UNA VEZ por un LLM al crear/editar la regla, persistida como JSONB
 * en `semantic_rules.structure`. Permite que el runtime traduzca la regla a
 * constraints concretos ({employeeId, shiftId}) sin hacer NLP en cada
 * generación de schedule.
 */

export type EmployeeMatcher =
  | { type: 'name'; value: string }
  | { type: 'all' };

export type DateMatcher =
  | { type: 'iso-date'; value: string } // ej. "2026-04-25"
  | { type: 'day-of-week'; value: string }; // ej. "lunes", "martes"

export type ShiftTypeMatcher = 'day' | 'night' | 'morning' | 'afternoon';

export type RuleIntent =
  | 'block'
  | 'permit-multi-shift'
  | 'preference'
  | 'complex';

export interface RuleStructure {
  intent: RuleIntent;
  employeeMatchers: EmployeeMatcher[];
  dateMatchers: DateMatcher[];
  shiftTypeMatchers?: ShiftTypeMatcher[];
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

  const intents: RuleIntent[] = ['block', 'permit-multi-shift', 'preference', 'complex'];
  if (typeof v.intent !== 'string' || !intents.includes(v.intent as RuleIntent)) {
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
  for (const d of v.dateMatchers) {
    const dd = d as Record<string, unknown>;
    if (
      (dd?.type === 'iso-date' || dd?.type === 'day-of-week') &&
      typeof dd.value === 'string'
    ) {
      continue;
    }
    return false;
  }

  if (v.shiftTypeMatchers !== undefined) {
    if (!Array.isArray(v.shiftTypeMatchers)) return false;
    const valid: ShiftTypeMatcher[] = ['day', 'night', 'morning', 'afternoon'];
    for (const s of v.shiftTypeMatchers) {
      if (typeof s !== 'string' || !valid.includes(s as ShiftTypeMatcher)) {
        return false;
      }
    }
  }

  return true;
}
