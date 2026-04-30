import { Injectable } from '@nestjs/common';
import type {
  PolicyEvaluationContext,
  PolicyInterpreter,
  PolicyViolation,
} from '../policy-interpreter.interface';

export interface MinRestHoursParams {
  /** Mínimo de horas entre el fin de un turno y el inicio del próximo
   *  para el mismo empleado. */
  hours: number;
}

const SPANISH_NUMBERS: Record<string, number> = {
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
};

/**
 * MinRestHoursBetweenShiftsInterpreter — "cada empleado descansa al
 * menos N horas entre turnos consecutivos". Las horas son parámetro
 * de la policy: cada tenant las define al crearla; el sistema NO trae
 * un default hardcoded.
 *
 * Heurística matches(): texto con (descanso|rest) + (entre turnos|between
 * shifts) + un número de horas. Idiomas: español + inglés.
 *
 * Nota (commit 8 acotado): el scheduler activo (WeekScheduleBuilder +
 * llm-line-proposer) NO consume todavía este interpreter — la
 * integración real al solver queda como trabajo aparte. Por ahora la
 * pieza queda catalogada para que: (1) el RuleRephraseService la pueda
 * proponer al manager cuando el texto matchee, y (2) la policy se
 * persista con interpreterId estructurado en lugar de quedar LLM-only.
 */
@Injectable()
export class MinRestHoursBetweenShiftsInterpreter
  implements PolicyInterpreter<MinRestHoursParams>
{
  readonly id = 'min_rest_hours_between_shifts';
  readonly description =
    'Cada empleado debe tener al menos N horas de descanso entre turnos consecutivos.';

  // Permite "horas" / "hora" / "hours" / "hour", con o sin "h"/"hs".
  private static readonly HOUR_NOUN = '(?:horas?|hours?|h|hs)';
  // Acepta hasta una palabra-adjetivo entre el número y el day-noun:
  // "11 horas" / "11 long hours" — y también el orden "rest of 11h".
  private static readonly NUM_HOUR =
    '(?:\\s+\\w+)?\\s*' + MinRestHoursBetweenShiftsInterpreter.HOUR_NOUN;

  matches(text: string): boolean {
    const t = text.toLowerCase();
    const hasRest = /descans|rest\s|de descanso/.test(t);
    const hasBetween = /entre turnos|entre cada turno|between shifts|between consecutive shifts/.test(t);
    const hourRe = MinRestHoursBetweenShiftsInterpreter.NUM_HOUR;
    const hasNumber =
      new RegExp(`\\b\\d+${hourRe}\\b`).test(t) ||
      Object.keys(SPANISH_NUMBERS).some((w) =>
        new RegExp(`\\b${w}${hourRe}\\b`).test(t),
      );
    return hasRest && hasBetween && hasNumber;
  }

  async extractParams(text: string): Promise<MinRestHoursParams> {
    const t = text.toLowerCase();
    const hourRe = MinRestHoursBetweenShiftsInterpreter.NUM_HOUR;

    let hours = 11; // default conservador (estaba como hardcode previo)
    const digit = t.match(new RegExp(`\\b(\\d+)${hourRe}\\b`));
    if (digit) {
      hours = parseInt(digit[1], 10);
    } else {
      for (const [word, n] of Object.entries(SPANISH_NUMBERS)) {
        if (new RegExp(`\\b${word}${hourRe}\\b`).test(t)) {
          hours = n;
          break;
        }
      }
    }
    return { hours };
  }

  async apply(
    ctx: PolicyEvaluationContext,
    params: MinRestHoursParams,
  ): Promise<PolicyViolation[]> {
    const violations: PolicyViolation[] = [];
    // Agrupar shifts por empleado.
    const byEmployee = new Map<string, typeof ctx.shifts>();
    for (const shift of ctx.shifts) {
      const list = byEmployee.get(shift.employeeId) ?? [];
      list.push(shift);
      byEmployee.set(shift.employeeId, list);
    }

    for (const [employeeId, shifts] of byEmployee) {
      // Ordenar por startTime para detectar pares consecutivos.
      const sorted = [...shifts].sort(
        (a, b) => a.startTime.getTime() - b.startTime.getTime(),
      );
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const gapMs = curr.startTime.getTime() - prev.endTime.getTime();
        const gapHours = gapMs / (1000 * 60 * 60);
        if (gapHours >= 0 && gapHours < params.hours) {
          violations.push({
            employeeId,
            scope: prev.endTime.toISOString(),
            message: `Employee ${employeeId} rests only ${gapHours.toFixed(1)} hours between shifts ending at ${prev.endTime.toISOString()} and starting at ${curr.startTime.toISOString()}, below the minimum of ${params.hours}.`,
          });
        }
      }
    }
    return violations;
  }

  format(params: MinRestHoursParams): string {
    return `Each employee must rest at least ${params.hours} hour${params.hours === 1 ? '' : 's'} between consecutive shifts.`;
  }
}
