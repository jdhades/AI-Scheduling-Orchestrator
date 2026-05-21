import { Injectable } from '@nestjs/common';
import type {
  PolicyEvaluationContext,
  PolicyInterpreter,
  PolicyViolation,
} from '../policy-interpreter.interface';
import { isoDate } from './iso-week.util';
import { companyWeekKey } from '../../shared/week';

export interface MinRestDaysParams {
  /** Mínimo de días sin trabajar por ISO-week. */
  days: number;
  /** Si false, los feriados no cuentan como día libre — son neutros. */
  holidayCounts: boolean;
}

const SPANISH_NUMBERS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
};

/**
 * MinRestDaysPerWeekInterpreter — "cada empleado debe tener al menos N
 * días libres por semana". Reemplaza la regla semantic equivalente que
 * el matcher schema actual no puede expresar (es un counting/distribution
 * constraint, no un matcher).
 *
 * Heurística matches(): texto que combina (descanso|libre|day off|rest)
 * con (semana|weekly) y un número (dígito o palabra). Es deliberadamente
 * permisiva — el extractParams hace la verificación exacta y el
 * suggestion-loop filtra los casos ambiguos antes de llegar acá.
 */
@Injectable()
export class MinRestDaysPerWeekInterpreter
  implements PolicyInterpreter<MinRestDaysParams>
{
  readonly id = 'min_rest_days_per_week';
  readonly description =
    'Cada empleado debe tener al menos N días libres por semana (respeta el inicio-de-semana del tenant). Opcional: excluir feriados del cómputo.';

  // Permite "días", "dias", "day" y "days" (plurales y singular ES/EN).
  private static readonly DAY_NOUN = '(?:d[ií]as?|days?)';
  // Acepta hasta una palabra-adjetivo entre el número y el day-noun:
  //   "2 días" / "dos días" (ES, número adyacente)
  //   "2 rest days" / "two rest days" (EN, idiom con rest entre medio)
  private static readonly NUM_DAY = '(?:\\s+\\w+)?\\s+' + MinRestDaysPerWeekInterpreter.DAY_NOUN;

  matches(text: string): boolean {
    const t = text.toLowerCase();
    const hasRest = /descans|d[ií]a libre|day off|rest days?|libres?/.test(t);
    const hasWeek = /semana|semanal|weekly|per week/.test(t);
    const dayRe = MinRestDaysPerWeekInterpreter.NUM_DAY;
    const hasNumber =
      new RegExp(`\\b\\d+${dayRe}\\b`).test(t) ||
      Object.keys(SPANISH_NUMBERS).some((w) =>
        new RegExp(`\\b${w}${dayRe}\\b`).test(t),
      );
    return hasRest && hasWeek && hasNumber;
  }

  async extractParams(text: string): Promise<MinRestDaysParams> {
    const t = text.toLowerCase();
    const dayRe = MinRestDaysPerWeekInterpreter.NUM_DAY;

    // Días: prioridad al número en dígitos.
    let days = 1;
    const digitMatch = t.match(new RegExp(`\\b(\\d+)${dayRe}\\b`));
    if (digitMatch) {
      days = parseInt(digitMatch[1], 10);
    } else {
      for (const [word, n] of Object.entries(SPANISH_NUMBERS)) {
        if (new RegExp(`\\b${word}${dayRe}\\b`).test(t)) {
          days = n;
          break;
        }
      }
    }

    // holidayCounts: si el texto menciona "aparte del feriado",
    // "sin contar feriado", "excluding holidays", "no cuenta", etc.,
    // entonces los feriados NO cuentan como rest day.
    const holidayCounts =
      !/feriado.*no cuenta|aparte del feriado|sin contar feriado|excluyendo feriado|excluding holiday|holidays? do(?:n['’]t| not) count/.test(
        t,
      );

    return { days, holidayCounts };
  }

  async apply(
    ctx: PolicyEvaluationContext,
    params: MinRestDaysParams,
  ): Promise<PolicyViolation[]> {
    const violations: PolicyViolation[] = [];
    const weekStartsOn = ctx.weekStartsOn ?? 'monday';
    // employeeId → (week → set<YYYY-MM-DD> de días con turno asignado)
    const grouped = new Map<string, Map<string, Set<string>>>();

    for (const shift of ctx.shifts) {
      const week = companyWeekKey(shift.startTime, weekStartsOn);
      const date = isoDate(shift.startTime);
      let weeksMap = grouped.get(shift.employeeId);
      if (!weeksMap) {
        weeksMap = new Map();
        grouped.set(shift.employeeId, weeksMap);
      }
      let dates = weeksMap.get(week);
      if (!dates) {
        dates = new Set();
        weeksMap.set(week, dates);
      }
      dates.add(date);
    }

    for (const [employeeId, weeksMap] of grouped) {
      for (const [week, workedDates] of weeksMap) {
        const totalDaysInWeek = 7;
        let restDays = totalDaysInWeek - workedDates.size;

        if (!params.holidayCounts && ctx.holidayDates) {
          // Restar de los rest days los feriados que caen en esa semana
          // y NO se trabajaron — son neutros, no cuentan como descanso.
          for (const holiday of ctx.holidayDates) {
            if (workedDates.has(holiday)) continue;
            // Verificar que el feriado pertenece a esta semana.
            if (
              companyWeekKey(new Date(`${holiday}T00:00:00Z`), weekStartsOn) ===
              week
            ) {
              restDays -= 1;
            }
          }
        }

        if (restDays < params.days) {
          violations.push({
            employeeId,
            scope: week,
            message:
              `Employee ${employeeId} has ${restDays} rest day${restDays === 1 ? '' : 's'} in week ${week}, ` +
              `below the minimum of ${params.days}` +
              (params.holidayCounts ? '.' : ' (holidays excluded).'),
          });
        }
      }
    }

    return violations;
  }

  format(params: MinRestDaysParams): string {
    return (
      `Each employee must have at least ${params.days} rest day${params.days === 1 ? '' : 's'} per week` +
      (params.holidayCounts
        ? '.'
        : ' (holidays do not count as rest days).')
    );
  }
}
