import { Injectable, Logger } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { SemanticRuleAggregate } from '../aggregates/semantic-rule.aggregate';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import {
  SEMANTIC_BLOCKED_ALL,
  type SemanticConstraint,
} from '../strategies/scheduling-strategy.interface';
import type {
  DateMatcher,
  HourRange,
  RuleStructure,
  ShiftNameMatcher,
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
 * Traduce `RuleStructure` + lista de empleados/slots de la semana →
 * constraints con IDs concretos (`slot.slotKey = templateId|YYYY-MM-DD`).
 * Sin NLP ni magic numbers: el matching es determinístico contra datos ya
 * extraídos por el LLM al guardar la regla (fechas, nombres de template,
 * rangos horarios explícitos).
 */
@Injectable()
export class StructuredRuleResolver {
  private readonly logger = new Logger(StructuredRuleResolver.name);

  resolve(
    rules: SemanticRuleAggregate[],
    employees: Employee[],
    slots: VirtualShiftSlot[],
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

      if (struct.intent === 'preference') continue;

      // Safety net: structure degenerada (block/permit sin datos concretos).
      const hasConcreteDates = struct.dateMatchers.length > 0;
      const hasConcreteNames = !!struct.shiftNameMatchers?.length;
      const hasConcreteHourRanges = !!struct.hourRangeMatchers?.length;
      const hasSpecificEmployees = struct.employeeMatchers.some(
        (m) => m.type === 'name',
      );
      if (
        !hasConcreteDates &&
        !hasConcreteNames &&
        !hasConcreteHourRanges &&
        !hasSpecificEmployees
      ) {
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
      const matchingSlots = this.matchSlots(struct, slots);
      const matchingEmployees = this.matchEmployees(struct, employees);

      if (struct.intent === 'block') {
        const { employeeIds, allEmployees } = matchingEmployees;

        // Safety anti-avalancha: si bloquea >50% de la semana para TODOS
        const total = slots.length;
        const wouldBlockAll =
          allEmployees && total > 0 && matchingSlots.length / total > 0.5;
        if (wouldBlockAll) {
          complexRules.push({
            ruleId: rule.getId(),
            ruleText: rule.getRuleText(),
            reason:
              `La structure cubriría ${matchingSlots.length}/${total} slots ` +
              `(${Math.round((matchingSlots.length / total) * 100)}%) para todos los ` +
              `empleados — probablemente es una regla de distribución, no de bloqueo.`,
          });
          continue;
        }

        for (const slot of matchingSlots) {
          if (allEmployees) {
            constraints.push({
              rule: rule.getRuleText(),
              weight,
              employeeId: SEMANTIC_BLOCKED_ALL,
              shiftId: slot.slotKey,
            });
          } else {
            for (const empId of employeeIds) {
              constraints.push({
                rule: rule.getRuleText(),
                weight,
                employeeId: empId,
                shiftId: slot.slotKey,
              });
            }
          }
        }

        // Regla que bloquea empleado sin restricción de slot (ej. "Pedro no de noche"
        // sin matching de ningún slot concreto)
        if (
          matchingSlots.length === 0 &&
          !allEmployees &&
          employeeIds.length > 0
        ) {
          for (const empId of employeeIds) {
            constraints.push({
              rule: rule.getRuleText(),
              weight,
              employeeId: empId,
            });
          }
        }
      }

      if (struct.intent === 'permit-multi-shift') {
        const daysAffected = this.expandDateMatchers(struct.dateMatchers, slots);
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

  private matchSlots(
    struct: RuleStructure,
    slots: VirtualShiftSlot[],
  ): VirtualShiftSlot[] {
    const hasDate = struct.dateMatchers.length > 0;
    const hasName = !!struct.shiftNameMatchers?.length;
    const hasHourRange = !!struct.hourRangeMatchers?.length;
    if (!hasDate && !hasName && !hasHourRange) return [];

    return slots.filter((slot) => {
      const dateOk = !hasDate || this.slotMatchesDate(slot, struct.dateMatchers);
      const nameOk =
        !hasName || this.slotMatchesName(slot, struct.shiftNameMatchers!);
      const hourOk =
        !hasHourRange ||
        this.slotMatchesHourRange(slot, struct.hourRangeMatchers!);
      return dateOk && nameOk && hourOk;
    });
  }

  private slotMatchesDate(
    slot: VirtualShiftSlot,
    matchers: DateMatcher[],
  ): boolean {
    const slotDayName = this.dayOfWeekName(slot.startTime.getUTCDay());
    return matchers.some((m) => {
      if (m.type === 'iso-date') return m.value === slot.date;
      if (m.type === 'day-of-week') return m.value === slotDayName;
      return false;
    });
  }

  /** Substring match case-insensitive sobre el nombre del template. */
  private slotMatchesName(
    slot: VirtualShiftSlot,
    matchers: ShiftNameMatcher[],
  ): boolean {
    const nameLower = slot.templateName.toLowerCase();
    return matchers.some((m) => nameLower.includes(m.toLowerCase()));
  }

  /**
   * ¿La hora de inicio del slot cae dentro de algún rango?
   * Si end < start el rango cruza medianoche (ej. 22:00–06:00).
   */
  private slotMatchesHourRange(
    slot: VirtualShiftSlot,
    ranges: HourRange[],
  ): boolean {
    const m = slot.startTime.getUTCHours() * 60 + slot.startTime.getUTCMinutes();
    return ranges.some((r) => {
      const [sh, sm] = r.start.split(':').map(Number);
      const [eh, em] = r.end.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      if (endMin > startMin) {
        return m >= startMin && m < endMin;
      }
      // Wraps midnight: [start, 24:00) ∪ [00:00, end)
      return m >= startMin || m < endMin;
    });
  }

  private expandDateMatchers(
    matchers: DateMatcher[],
    slots: VirtualShiftSlot[],
  ): string[] {
    const days = new Set<string>();
    for (const slot of slots) {
      if (this.slotMatchesDate(slot, matchers)) days.add(slot.date);
    }
    return [...days];
  }

  private dayOfWeekName(d: number): string {
    const names = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    return names[d];
  }
}
