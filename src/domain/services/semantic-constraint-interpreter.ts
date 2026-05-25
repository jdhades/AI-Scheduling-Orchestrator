import type { Employee } from '../aggregates/employee.aggregate';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import {
  type SemanticConstraint,
  SEMANTIC_BLOCKED_ALL,
} from '../types/scheduling-types';

/**
 * SemanticConstraintInterpreter — Domain Service (pure, sin dependencias externas)
 *
 * Convierte SemanticConstraint[] con texto en lenguaje natural a constraints con
 * IDs concretos (employeeId, shiftId), listos para ser aplicados por las estrategias.
 *
 * Pipeline:
 *   1. Para cada constraint, analiza el texto con pattern matching
 *   2. Detecta nombres de empleados → resuelve a employeeId
 *   3. Detecta fechas/días → resuelve a shiftId(s)
 *   4. Detecta patrones "nadie trabaja" → usa SEMANTIC_BLOCKED_ALL
 *   5. Expande: una regla puede generar N constraints (uno por turno afectado)
 *
 * Resiliencia: si no hay match, devuelve la constraint original sin IDs.
 * Las estrategias ignorarán constraints sin IDs, comportamiento seguro.
 *
 * IMPORTANTE: Este intérprete usa pattern matching en español/inglés.
 * Diseñado para el idioma del negocio (ES). Sin dependencia de LLM.
 */
export class SemanticConstraintInterpreter {
  /**
   * Patrones que indican bloqueo total del turno (nadie puede trabajar).
   *
   * TODO(config-per-tenant): hardcodeado en español/inglés. Mismo problema que
   * `ROTATING_DAY_OFF_PATTERNS` que se eliminó: pattern matching frágil. Solo
   * se usa en el path determinístico puro (sin LLM); cuando el LLM responde,
   * los blocks vienen ya resueltos. Considerar mover a config por idioma o
   * delegar 100% al LLM y eliminar este intérprete.
   */
  private static readonly ALL_BLOCKED_PATTERNS = [
    'nadie trabaja',
    'nadie puede trabajar',
    'todos descansan',
    'día festivo',
    'dia festivo',
    'feriado',
    'festivo',
    'cerrado',
    'día libre',
    'dia libre',
    'no hay servicio',
    'nobody works',
    'holiday',
    'day off',
    'closed',
  ];

  /** Nombres de días de la semana en español → índice JS (0=domingo) */
  private static readonly DAY_NAMES: Record<string, number> = {
    domingo: 0,
    lunes: 1,
    martes: 2,
    miércoles: 3,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sábado: 6,
    sabado: 6,
  };

  /** Nombres de meses en español → índice JS (0=enero) */
  private static readonly MONTH_NAMES: Record<string, number> = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };

  /**
   * Enriquece constraints con IDs resueltos a partir del texto de cada regla.
   *
   * Una regla puede expandirse en múltiples constraints si afecta varios turnos.
   * Por ejemplo, "los lunes nadie trabaja" genera un constraint por cada turno de lunes.
   *
   * @param constraints  Constraints con texto y weight, sin IDs
   * @param employees    Lista completa de empleados de la empresa
   * @param shifts       Lista de turnos de la semana a generar
   * @returns            Constraints enriquecidos (pueden ser más que los originales)
   */
  static interpret(
    constraints: SemanticConstraint[],
    employees: Employee[],
    slots: VirtualShiftSlot[],
  ): SemanticConstraint[] {
    if (constraints.length === 0 || slots.length === 0) return constraints;

    const result: SemanticConstraint[] = [];

    for (const constraint of constraints) {
      if (constraint.employeeId && constraint.shiftId) {
        result.push(constraint);
        continue;
      }
      const expanded = this.expandConstraint(constraint, employees, slots);
      result.push(...expanded);
    }

    return result;
  }

  private static expandConstraint(
    constraint: SemanticConstraint,
    employees: Employee[],
    slots: VirtualShiftSlot[],
  ): SemanticConstraint[] {
    const ruleLower = constraint.rule
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const isAllBlocked = this.ALL_BLOCKED_PATTERNS.some((p) =>
      ruleLower.includes(p.normalize('NFD').replace(/[\u0300-\u036f]/g, '')),
    );

    const matchingSlots = this.extractMatchingSlots(ruleLower, slots);
    const matchingEmployees = this.extractMatchingEmployees(
      ruleLower,
      employees,
    );

    if (isAllBlocked && matchingSlots.length > 0) {
      return matchingSlots.map((slot) => ({
        ...constraint,
        shiftId: slot.slotKey,
        employeeId: SEMANTIC_BLOCKED_ALL,
      }));
    }

    if (matchingEmployees.length > 0 && matchingSlots.length > 0) {
      const expanded: SemanticConstraint[] = [];
      for (const emp of matchingEmployees) {
        for (const slot of matchingSlots) {
          expanded.push({
            ...constraint,
            employeeId: emp.id,
            shiftId: slot.slotKey,
          });
        }
      }
      return expanded;
    }

    // Caso 3: "Ana no puede trabajar turnos nocturnos" → bloquear empleado en todos los turnos (sin shiftId)
    if (matchingEmployees.length > 0) {
      return matchingEmployees.map((emp) => ({
        ...constraint,
        employeeId: emp.id,
      }));
    }

    // Caso 4: "el 16 de abril cerrado" sin detectar "nadie trabaja" pero con alta prioridad
    if (isAllBlocked && matchingSlots.length === 0 && constraint.weight >= 2) {
      // No encontramos turnos concretos — devolver constraint original sin IDs
      return [constraint];
    }

    // Caso 5: Sin match — devolver original (las estrategias lo ignorarán)
    return [constraint];
  }

  /**
   * Extrae los slots virtuales que coinciden con patrones de fecha/día.
   */
  private static extractMatchingSlots(
    ruleLower: string,
    slots: VirtualShiftSlot[],
  ): VirtualShiftSlot[] {
    const matched = new Set<VirtualShiftSlot>();

    const dayMonthPattern = /\b(\d{1,2})\s+de\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = dayMonthPattern.exec(ruleLower)) !== null) {
      const day = parseInt(match[1], 10);
      const monthName = match[2]
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const monthIndex = this.MONTH_NAMES[monthName];
      if (monthIndex !== undefined) {
        slots
          .filter(
            (s) =>
              s.startTime.getUTCDate() === day &&
              s.startTime.getUTCMonth() === monthIndex,
          )
          .forEach((s) => matched.add(s));
      }
    }

    const isoPattern = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((match = isoPattern.exec(ruleLower)) !== null) {
      const isoStr = `${match[1]}-${match[2]}-${match[3]}`;
      slots.filter((s) => s.date === isoStr).forEach((s) => matched.add(s));
    }

    for (const [dayName, dayIndex] of Object.entries(this.DAY_NAMES)) {
      const normalizedDay = dayName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      if (ruleLower.includes(normalizedDay)) {
        slots
          .filter((s) => s.startTime.getUTCDay() === dayIndex)
          .forEach((s) => matched.add(s));
      }
    }

    if (ruleLower.includes('fin de semana') || ruleLower.includes('weekend')) {
      slots
        .filter((s) => {
          const day = s.startTime.getUTCDay();
          return day === 0 || day === 6;
        })
        .forEach((s) => matched.add(s));
    }

    return [...matched];
  }

  /**
   * Extrae empleados cuyos nombres aparecen en el texto de la regla.
   * Usa comparación case-insensitive sobre el nombre completo y primer nombre.
   */
  private static extractMatchingEmployees(
    ruleLower: string,
    employees: Employee[],
  ): Employee[] {
    return employees.filter((emp) => {
      const nameLower = emp.name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      if (ruleLower.includes(nameLower)) return true;

      // También comparar solo el primer nombre (ej: "Ana" coincide con "Ana García")
      const firstName = nameLower.split(' ')[0];
      if (firstName.length >= 3 && ruleLower.includes(firstName)) return true;

      return false;
    });
  }
}
