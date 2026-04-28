/**
 * RuleType — Value Object
 *
 * Clasifica el tipo de comportamiento de una regla semántica:
 *
 *   restriction  — Bloquea la asignación si se viola. El scheduler busca otro candidato.
 *   preference   — Orienta la elección sin bloquear. Se respeta si hay candidatos equivalentes.
 *   requirement  — El turno requiere que SE CUMPLA la condición. Similar a restriction
 *                  pero semánticamente indica un requisito del turno, no una prohibición.
 *
 * Es inmutable — no puede modificarse una vez creado.
 */
export type RuleTypeValue = 'restriction' | 'preference' | 'requirement';

export class RuleType {
  private static readonly VALID_VALUES: RuleTypeValue[] = [
    'restriction',
    'preference',
    'requirement',
  ];

  private constructor(private readonly value: RuleTypeValue) {}

  static restriction(): RuleType {
    return new RuleType('restriction');
  }

  static preference(): RuleType {
    return new RuleType('preference');
  }

  static requirement(): RuleType {
    return new RuleType('requirement');
  }

  static create(value: string): RuleType {
    if (!RuleType.VALID_VALUES.includes(value as RuleTypeValue)) {
      throw new Error(
        `Invalid RuleType: "${value}". Valid values: ${RuleType.VALID_VALUES.join(', ')}`,
      );
    }
    return new RuleType(value as RuleTypeValue);
  }

  /** True si la regla puede bloquear activamente una asignación */
  isBlocking(): boolean {
    return this.value === 'restriction' || this.value === 'requirement';
  }

  /** True específicamente si es una restricción (prohibición) */
  isRestriction(): boolean {
    return this.value === 'restriction';
  }

  /** True si es solo una preferencia (no bloquea) */
  isPreference(): boolean {
    return this.value === 'preference';
  }

  /** True si es un requisito del turno */
  isRequirement(): boolean {
    return this.value === 'requirement';
  }

  equals(other: RuleType): boolean {
    return this.value === other.value;
  }

  getValue(): RuleTypeValue {
    return this.value;
  }

  toString(): string {
    return `RuleType(${this.value})`;
  }
}
