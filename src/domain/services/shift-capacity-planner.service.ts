import { Injectable, Logger } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';

/**
 * ShiftCapacityPlannerService — Servicio de Dominio
 *
 * Pre-computa cuántos empleados debe recibir cada turno ANTES de llamar al LLM.
 * Esto elimina el concepto ambiguo de "Capacidad: Ilimitada" del prompt.
 *
 * Proceso (por día de calendario):
 *   1. Agrupar turnos por día
 *   2. Detectar empleados excluidos ese día vía matching de reglas semánticas (best-effort)
 *   3. Separar turnos estrictos (requiredEmployees != null) de dinámicos (null)
 *   4. Distribuir empleados disponibles entre turnos dinámicos con ceil()
 *
 * Casos especiales:
 *   - Feriado total → disponibles=0 → cuota=0 → LLM devuelve NONE
 *   - Más turnos dinámicos que empleados → algunos quedan en 0 (los de menor prioridad)
 *   - Sin turnos dinámicos → el mapa solo contiene las cuotas estrictas
 */
@Injectable()
export class ShiftCapacityPlannerService {
  private readonly logger = new Logger(ShiftCapacityPlannerService.name);

  /**
   * Calcula la capacidad concreta para cada turno.
   *
   * @returns Map<shiftId, resolvedCapacity> donde:
   *   - Turnos estrictos → su requiredEmployees original
   *   - Turnos dinámicos → cuota calculada (puede ser 0 si feriado o sin empleados)
   */
  plan(params: {
    employees: Employee[];
    shifts: Shift[];
    semanticRules: SemanticConstraint[];
  }): Map<string, number> {
    const { employees, shifts, semanticRules } = params;
    const result = new Map<string, number>();

    // Agrupar turnos por día (ISO date string "YYYY-MM-DD")
    const shiftsByDay = this.groupShiftsByDay(shifts);

    for (const [day, dayShifts] of shiftsByDay) {
      // Detectar empleados excluidos este día por reglas semánticas (best-effort)
      const excludedCount = this.estimateExcludedEmployees(day, employees, semanticRules);
      const availableCount = Math.max(0, employees.length - excludedCount);

      // Separar turnos estrictos de dinámicos
      const strictShifts = dayShifts.filter((s) => s.requiredEmployees !== null);
      const dynamicShifts = dayShifts.filter((s) => s.requiredEmployees === null);

      // Los turnos estrictos ya tienen su cuota
      for (const shift of strictShifts) {
        result.set(shift.id, shift.requiredEmployees!);
      }

      // Pool restante después de "reservar" los turnos estrictos
      // (una reserva conservadora: no duplicamos empleados, asumimos que los
      //  estrictos consumen al menos 1 persona cada uno del pool del día)
      const strictConsumption = strictShifts.reduce(
        (acc, s) => acc + s.requiredEmployees!,
        0,
      );
      const poolForDynamic = Math.max(0, availableCount - strictConsumption);

      if (dynamicShifts.length === 0) {
        // Nada que distribuir
        this.logger.debug(
          `Day ${day}: no dynamic shifts — ${strictShifts.length} strict shifts set.`,
        );
        continue;
      }

      if (poolForDynamic === 0) {
        // Sin empleados disponibles (feriado total o todos consumidos por estrictos)
        this.logger.log(
          `Day ${day}: pool exhausted (available=${availableCount}, strict consumption=${strictConsumption}) — all ${dynamicShifts.length} dynamic shifts → capacity 0`,
        );
        for (const shift of dynamicShifts) {
          result.set(shift.id, 0);
        }
        continue;
      }

      // Distribuir el pool entre los turnos dinámicos
      // Ejemplo: 5 empleados / 2 turnos → turno 1 = 3, turno 2 = 2
      this.distributePool(poolForDynamic, dynamicShifts, result);

      this.logger.debug(
        `Day ${day}: available=${availableCount} strict_consumption=${strictConsumption} pool=${poolForDynamic} → distributed among ${dynamicShifts.length} dynamic shifts`,
      );
    }

    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Agrupa los turnos por su fecha (YYYY-MM-DD en UTC) */
  private groupShiftsByDay(shifts: Shift[]): Map<string, Shift[]> {
    const map = new Map<string, Shift[]>();
    for (const shift of shifts) {
      const day = shift.startTime.toISOString().split('T')[0];
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(shift);
    }
    return map;
  }

  /**
   * Estima cuántos empleados están excluidos en un día concreto según
   * las reglas semánticas (matching de texto, best-effort).
   *
   * Patrones detectados:
   *   - Mención del día de la semana (lunes, martes…) o de la fecha ISO en el texto de la regla
   *   - Si la regla menciona "todos" o "feriado" → excluye a TODOS los empleados
   *   - Si menciona el nombre de un empleado concreto (no implementado sin datos de nombres)
   *
   * Las reglas ambiguas (sin fecha explícita) se ignoran aquí y
   * el LLM las maneja por su cuenta con el texto completo de la regla.
   */
  private estimateExcludedEmployees(
    dayIso: string, // "YYYY-MM-DD"
    employees: Employee[],
    semanticRules: SemanticConstraint[],
  ): number {
    const date = new Date(dayIso + 'T12:00:00Z');
    const dayName = date
      .toLocaleDateString('es-ES', { weekday: 'long' })
      .toLowerCase();
    const dayNameEn = date
      .toLocaleDateString('en-US', { weekday: 'long' })
      .toLowerCase();

    let excludeAll = false;
    let excludedByName = 0;

    for (const constraint of semanticRules) {
      const text = constraint.rule.toLowerCase();

      // Solo analizar reglas que mencionen este día concreto
      const mentionsThisDay =
        text.includes(dayIso) ||
        text.includes(dayName) ||
        text.includes(dayNameEn);

      if (!mentionsThisDay) continue;

      // Feriado o descanso colectivo → excluye toda la plantilla
      if (
        text.includes('feriado') ||
        text.includes('holiday') ||
        text.includes('todos descansan') ||
        text.includes('cerrado') ||
        text.includes('nadie trabaja') ||
        text.includes('día festivo')
      ) {
        excludeAll = true;
        this.logger.log(
          `Day ${dayIso}: collective rest rule detected → all ${employees.length} employees excluded`,
        );
        break;
      }

      // Exclusión de empleado individual por nombre (nombre del employee en el texto)
      for (const employee of employees) {
        const nameParts = employee.name.toLowerCase().split(' ');
        if (nameParts.some((part) => part.length > 2 && text.includes(part))) {
          excludedByName++;
          this.logger.debug(
            `Day ${dayIso}: employee "${employee.name}" excluded by rule: "${constraint.rule.substring(0, 60)}"`,
          );
        }
      }
    }

    if (excludeAll) return employees.length;
    return Math.min(excludedByName, employees.length);
  }

  /**
   * Distribuye poolSize empleados entre los turnos dinámicos usando ceil().
   * El último turno obtiene el residuo (puede ser menor que ceil si no alcanza).
   *
   * Ejemplo: pool=5, shifts=[mañana, tarde]
   *   mañana → ceil(5/2) = 3
   *   tarde  → 5 - 3 = 2
   */
  private distributePool(
    pool: number,
    dynamicShifts: Shift[],
    result: Map<string, number>,
  ): void {
    const n = dynamicShifts.length;
    let remaining = pool;

    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const quota = isLast ? remaining : Math.ceil(remaining / (n - i));
      result.set(dynamicShifts[i].id, Math.max(0, quota));
      remaining -= quota;
    }
  }
}
