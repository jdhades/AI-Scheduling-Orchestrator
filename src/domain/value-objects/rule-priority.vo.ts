/**
 * RulePriority — Value Object
 *
 * Encapsula la precedencia de una regla semántica en el sistema de scheduling.
 *
 * Niveles:
 *   1 = legal     — Máxima precedencia (EU Working Time Directive, contratos laborales)
 *   2 = semantic  — Reglas de la empresa escritas en lenguaje natural (default)
 *   3 = preference — Sugerencias que ceden ante restricciones
 *
 * Nota: un valor numérico MENOR = prioridad MÁS ALTA.
 * Es inmutable — no puede modificarse una vez creado.
 */
export class RulePriority {
  static readonly LEGAL = 1 as const;
  static readonly SEMANTIC = 2 as const;
  static readonly PREFERENCE = 3 as const;

  private constructor(private readonly value: 1 | 2 | 3) {}

  /** Crea una prioridad legal (nivel más alto). Usada para restricciones regulatorias. */
  static legal(): RulePriority {
    return new RulePriority(RulePriority.LEGAL);
  }

  /** Crea una prioridad semántica (nivel medio, default). Usada para reglas de empresa. */
  static semantic(): RulePriority {
    return new RulePriority(RulePriority.SEMANTIC);
  }

  /** Crea una prioridad de preferencia (nivel más bajo). Usada para sugerencias. */
  static preference(): RulePriority {
    return new RulePriority(RulePriority.PREFERENCE);
  }

  /** Crea desde un valor numérico (ej. al cargar desde DB). */
  static create(value: number): RulePriority {
    if (![1, 2, 3].includes(value)) {
      throw new Error(
        `Invalid RulePriority: ${value}. Must be 1 (legal), 2 (semantic), or 3 (preference)`,
      );
    }
    return new RulePriority(value as 1 | 2 | 3);
  }

  /**
   * Retorna true si esta prioridad es más alta que `other`.
   * Un valor numérico menor = mayor prioridad.
   * Ejemplo: legal (1).isHigherThan(semantic (2)) === true
   */
  isHigherThan(other: RulePriority): boolean {
    return this.value < other.value;
  }

  /** Retorna true si ambas prioridades son iguales. */
  equals(other: RulePriority): boolean {
    return this.value === other.value;
  }

  /** Valor numérico para persistencia y comparación. */
  getValue(): number {
    return this.value;
  }

  /** Etiqueta legible para logs y reportes. */
  toLabel(): string {
    const labels: Record<number, string> = {
      1: 'legal',
      2: 'semantic',
      3: 'preference',
    };
    return labels[this.value];
  }

  toString(): string {
    return `RulePriority(${this.value}:${this.toLabel()})`;
  }
}
