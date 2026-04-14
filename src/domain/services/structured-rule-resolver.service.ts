import { Injectable, Logger } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { SemanticRuleAggregate } from '../aggregates/semantic-rule.aggregate';
import {
  SEMANTIC_BLOCKED_ALL,
  type SemanticConstraint,
} from '../strategies/scheduling-strategy.interface';
import type {
  DateMatcher,
  RuleStructure,
  ShiftTypeMatcher,
} from '../value-objects/rule-structure.vo';

export interface ResolvedRuleOutput {
  /** Constraints listos para validator y strategies. */
  constraints: SemanticConstraint[];
  /** Permisos de doble turno (`${employeeId}|YYYY-MM-DD`). */
  multiShiftPermits: Set<string>;
  /** Reglas marcadas como 'complex' por el LLM — requieren supervisión humana. */
  complexRules: { ruleId: string; ruleText: string; reason: string }[];
  /** Reglas sin structure (no fueron analizadas por el LLM). */
  unstructuredRules: { ruleId: string; ruleText: string }[];
}

/**
 * StructuredRuleResolver — Domain Service
 *
 * Traduce `RuleStructure` + lista de empleados/shifts de la semana →
 * constraints concretos con IDs resueltos. Sin NLP ni patrones hardcodeados:
 * el LLM ya hizo el análisis al guardar la regla, aquí solo se hace matching
 * determinístico contra los IDs de la semana.
 */
@Injectable()
export class StructuredRuleResolver {
  private readonly logger = new Logger(StructuredRuleResolver.name);

  resolve(
    rules: SemanticRuleAggregate[],
    employees: Employee[],
    shifts: Shift[],
  ): ResolvedRuleOutput {
    const constraints: SemanticConstraint[] = [];
    const multiShiftPermits = new Set<string>();
    const complexRules: ResolvedRuleOutput['complexRules'] = [];
    const unstructuredRules: ResolvedRuleOutput['unstructuredRules'] = [];

    for (const rule of rules) {
      const struct = rule.getStructure();
      if (!struct) {
        unstructuredRules.push({
          ruleId: rule.getId(),
          ruleText: rule.getRuleText(),
        });
        continue;
      }

      if (struct.intent === 'complex') {
        complexRules.push({
          ruleId: rule.getId(),
          ruleText: rule.getRuleText(),
          reason: struct.complexReason ?? 'sin explicación del LLM',
        });
        continue;
      }

      if (struct.intent === 'preference') {
        // No genera hard constraints, solo se reporta como informativo.
        continue;
      }

      // Safety net: structure degenerada (block/permit sin datos concretos).
      // Si el LLM marcó block/permit pero no hay matchers útiles, la regla se
      // silenciaría. La tratamos como complex y reportamos warning al manager.
      const hasConcreteDates = struct.dateMatchers.length > 0;
      const hasConcreteShiftTypes = !!struct.shiftTypeMatchers?.length;
      const hasSpecificEmployees = struct.employeeMatchers.some(
        (m) => m.type === 'name',
      );
      if (!hasConcreteDates && !hasConcreteShiftTypes && !hasSpecificEmployees) {
        complexRules.push({
          ruleId: rule.getId(),
          ruleText: rule.getRuleText(),
          reason:
            `Structure degenerada (intent=${struct.intent} sin matchers concretos) — ` +
            `el LLM no pudo extraer datos útiles. Revisá el texto de la regla.`,
        });
        continue;
      }

      const weight = this.priorityToWeight(rule.getPriority().getValue());
      const matchingShifts = this.matchShifts(struct, shifts);
      const matchingEmployees = this.matchEmployees(struct, employees);

      if (struct.intent === 'block') {
        const { employeeIds, allEmployees } = matchingEmployees;

        // Safety net anti-avalancha: si una sola regla con allEmployees bloquearía
        // más de la mitad de los turnos de la semana, casi seguro el LLM la interpretó
        // mal (ej. "cada empleado día libre" → bloqueó toda la semana). Tratarla como
        // complex y avisar al manager en vez de aplicarla silenciosamente.
        const totalShiftsInWeek = shifts.length;
        const wouldBlockAll =
          allEmployees &&
          totalShiftsInWeek > 0 &&
          matchingShifts.length / totalShiftsInWeek > 0.5;
        if (wouldBlockAll) {
          complexRules.push({
            ruleId: rule.getId(),
            ruleText: rule.getRuleText(),
            reason:
              `La structure cubriría ${matchingShifts.length}/${totalShiftsInWeek} turnos (${Math.round((matchingShifts.length / totalShiftsInWeek) * 100)}%) para todos los empleados — ` +
              `probablemente es una regla de distribución, no de bloqueo. Revisá el texto.`,
          });
          continue;
        }

        for (const shift of matchingShifts) {
          if (allEmployees) {
            constraints.push({
              rule: rule.getRuleText(),
              weight,
              employeeId: SEMANTIC_BLOCKED_ALL,
              shiftId: shift.id,
            });
          } else {
            for (const empId of employeeIds) {
              constraints.push({
                rule: rule.getRuleText(),
                weight,
                employeeId: empId,
                shiftId: shift.id,
              });
            }
          }
        }
        // Si la regla bloquea a un empleado sin restricción de shift (ej. "Pedro nunca de noche" sin fecha),
        // generar constraints contra todos los shifts del tipo matcheado.
        if (matchingShifts.length === 0 && !allEmployees && employeeIds.length > 0) {
          for (const empId of employeeIds) {
            constraints.push({
              rule: rule.getRuleText(),
              weight,
              employeeId: empId,
              // sin shiftId → aplica a todos; las strategies ya lo interpretan así
            });
          }
        }
      }

      if (struct.intent === 'permit-multi-shift') {
        const daysAffected = this.expandDateMatchers(struct.dateMatchers, shifts);
        for (const empId of matchingEmployees.employeeIds) {
          for (const day of daysAffected) {
            multiShiftPermits.add(`${empId}|${day}`);
          }
        }
      }
    }

    this.logger.log(
      `StructuredRuleResolver: ${rules.length} rules → ${constraints.length} constraints, ` +
        `${multiShiftPermits.size} permits, ${complexRules.length} complex, ${unstructuredRules.length} unstructured`,
    );

    return { constraints, multiShiftPermits, complexRules, unstructuredRules };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private priorityToWeight(priorityLevel: number): number {
    return Math.max(1, 4 - priorityLevel);
  }

  private matchEmployees(
    struct: RuleStructure,
    employees: Employee[],
  ): { employeeIds: string[]; allEmployees: boolean } {
    const ids: string[] = [];
    let all = false;
    for (const m of struct.employeeMatchers) {
      if (m.type === 'all') {
        all = true;
        continue;
      }
      const target = m.value.toLowerCase();
      for (const emp of employees) {
        const empName = emp.name.toLowerCase();
        if (empName === target || empName.split(' ')[0] === target) {
          ids.push(emp.id);
        }
      }
    }
    return { employeeIds: Array.from(new Set(ids)), allEmployees: all };
  }

  private matchShifts(struct: RuleStructure, shifts: Shift[]): Shift[] {
    // Si no hay matchers de fecha ni de tipo → no devolvemos shifts (la regla
    // aplica a empleados globalmente, ver caso "sin matchingShifts" en resolve()).
    const hasDate = struct.dateMatchers.length > 0;
    const hasType = !!struct.shiftTypeMatchers && struct.shiftTypeMatchers.length > 0;
    if (!hasDate && !hasType) return [];

    return shifts.filter((s) => {
      const matchesDate = !hasDate || this.shiftMatchesDate(s, struct.dateMatchers);
      const matchesType =
        !hasType || this.shiftMatchesType(s, struct.shiftTypeMatchers!);
      return matchesDate && matchesType;
    });
  }

  private shiftMatchesDate(shift: Shift, matchers: DateMatcher[]): boolean {
    const shiftDay = shift.startTime.toISOString().split('T')[0];
    const dayOfWeek = shift.startTime.getUTCDay(); // 0=Sun, 1=Mon...
    const dayNames = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    const shiftDayName = dayNames[dayOfWeek];

    return matchers.some((m) => {
      if (m.type === 'iso-date') return m.value === shiftDay;
      if (m.type === 'day-of-week') return m.value === shiftDayName;
      return false;
    });
  }

  private shiftMatchesType(shift: Shift, matchers: ShiftTypeMatcher[]): boolean {
    const hour = shift.startTime.getUTCHours();
    // Mapeo simple basado en hora de inicio. Ajustable por empresa más adelante.
    const isNight = hour >= 22 || hour < 6;
    const isMorning = hour >= 6 && hour < 12;
    const isAfternoon = hour >= 12 && hour < 18;
    const isDay = !isNight;

    return matchers.some((m) => {
      if (m === 'night') return isNight;
      if (m === 'morning') return isMorning;
      if (m === 'afternoon') return isAfternoon;
      if (m === 'day') return isDay;
      return false;
    });
  }

  private expandDateMatchers(
    matchers: DateMatcher[],
    shifts: Shift[],
  ): string[] {
    const days = new Set<string>();
    for (const shift of shifts) {
      const shiftDay = shift.startTime.toISOString().split('T')[0];
      if (this.shiftMatchesDate(shift, matchers)) {
        days.add(shiftDay);
      }
    }
    return [...days];
  }
}
