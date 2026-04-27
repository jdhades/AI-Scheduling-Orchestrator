/**
 * PolicySeverity — Value Object
 *
 * Encapsula cómo el scheduler debe respetar una CompanyPolicy:
 *   - 'hard' = constraint inviolable (el solver descarta cualquier
 *              schedule que la viole; típico para horas de descanso,
 *              límites máximos legales, etc.).
 *   - 'soft' = preferencia (el solver intenta respetarla pero puede
 *              violarla si no hay alternativa; típico para horarios
 *              preferidos, balance de fairness, etc.).
 *
 * Inmutable — `create()` valida el valor y devuelve una instancia.
 */
export type PolicySeverityValue = 'hard' | 'soft';

export class PolicySeverity {
  static readonly HARD: PolicySeverityValue = 'hard';
  static readonly SOFT: PolicySeverityValue = 'soft';

  private static readonly VALID_VALUES: readonly PolicySeverityValue[] = [
    PolicySeverity.HARD,
    PolicySeverity.SOFT,
  ];

  private constructor(private readonly value: PolicySeverityValue) {}

  static create(value: string): PolicySeverity {
    if (!PolicySeverity.VALID_VALUES.includes(value as PolicySeverityValue)) {
      throw new Error(
        `Invalid PolicySeverity "${value}" — must be one of ${PolicySeverity.VALID_VALUES.join(', ')}`,
      );
    }
    return new PolicySeverity(value as PolicySeverityValue);
  }

  getValue(): PolicySeverityValue {
    return this.value;
  }

  isHard(): boolean {
    return this.value === PolicySeverity.HARD;
  }

  isSoft(): boolean {
    return this.value === PolicySeverity.SOFT;
  }

  equals(other: PolicySeverity): boolean {
    return this.value === other.value;
  }
}
