import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import {
  type SemanticConstraint,
  SEMANTIC_BLOCKED_ALL,
} from '../strategies/scheduling-strategy.interface';

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
  /** Patrones que indican bloqueo total del turno (nadie puede trabajar) */
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
    'miércoles': 3,
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
    shifts: Shift[],
  ): SemanticConstraint[] {
    if (constraints.length === 0 || shifts.length === 0) return constraints;

    const result: SemanticConstraint[] = [];

    for (const constraint of constraints) {
      const expanded = this.expandConstraint(constraint, employees, shifts);
      result.push(...expanded);
    }

    return result;
  }

  private static expandConstraint(
    constraint: SemanticConstraint,
    employees: Employee[],
    shifts: Shift[],
  ): SemanticConstraint[] {
    const ruleLower = constraint.rule.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const isAllBlocked = this.ALL_BLOCKED_PATTERNS.some((p) =>
      ruleLower.includes(p.normalize('NFD').replace(/[\u0300-\u036f]/g, '')),
    );

    const matchingShifts = this.extractMatchingShifts(ruleLower, shifts);
    const matchingEmployees = this.extractMatchingEmployees(ruleLower, employees);

    // Caso 1: "el 16 de abril nadie trabaja" → bloquear todos los empleados en esos turnos
    if (isAllBlocked && matchingShifts.length > 0) {
      return matchingShifts.map((shift) => ({
        ...constraint,
        shiftId: shift.id,
        employeeId: SEMANTIC_BLOCKED_ALL,
      }));
    }

    // Caso 2: "Ana no puede trabajar los lunes" → bloquear empleados específicos en turnos específicos
    if (matchingEmployees.length > 0 && matchingShifts.length > 0) {
      const expanded: SemanticConstraint[] = [];
      for (const emp of matchingEmployees) {
        for (const shift of matchingShifts) {
          expanded.push({ ...constraint, employeeId: emp.id, shiftId: shift.id });
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
    if (isAllBlocked && matchingShifts.length === 0 && constraint.weight >= 2) {
      // No encontramos turnos concretos — devolver constraint original sin IDs
      return [constraint];
    }

    // Caso 5: Sin match — devolver original (las estrategias lo ignorarán)
    return [constraint];
  }

  /**
   * Extrae los turnos que coinciden con patrones de fecha/día en el texto de la regla.
   */
  private static extractMatchingShifts(
    ruleLower: string,
    shifts: Shift[],
  ): Shift[] {
    const matched = new Set<Shift>();

    // Patrón: "el 16 de abril", "el día 16 de abril", "el 16/04"
    const dayMonthPattern = /\b(\d{1,2})\s+de\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = dayMonthPattern.exec(ruleLower)) !== null) {
      const day = parseInt(match[1], 10);
      const monthName = match[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const monthIndex = this.MONTH_NAMES[monthName];
      if (monthIndex !== undefined) {
        shifts
          .filter(
            (s) =>
              s.startTime.getUTCDate() === day &&
              s.startTime.getUTCMonth() === monthIndex,
          )
          .forEach((s) => matched.add(s));
      }
    }

    // Patrón ISO: "2024-04-16"
    const isoPattern = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((match = isoPattern.exec(ruleLower)) !== null) {
      const isoStr = `${match[1]}-${match[2]}-${match[3]}`;
      shifts
        .filter((s) => s.startTime.toISOString().startsWith(isoStr))
        .forEach((s) => matched.add(s));
    }

    // Patrón día de semana: "los lunes", "cada martes", "el viernes"
    for (const [dayName, dayIndex] of Object.entries(this.DAY_NAMES)) {
      const normalizedDay = dayName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (ruleLower.includes(normalizedDay)) {
        shifts
          .filter((s) => s.startTime.getUTCDay() === dayIndex)
          .forEach((s) => matched.add(s));
      }
    }

    // Patrón "fin de semana"
    if (ruleLower.includes('fin de semana') || ruleLower.includes('weekend')) {
      shifts
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
