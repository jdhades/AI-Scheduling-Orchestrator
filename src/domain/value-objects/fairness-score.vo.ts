/**
 * FairnessScore — Value Object
 *
 * Representa el puntaje de carga acumulada de un empleado.
 * Calculado por FairnessCalculator usando la fórmula:
 *   (undesirable×2) + (night×1.5) + (weekend×1.2) - (voluntary×0.5)
 *
 * Rango: 0–1000 (suficiente para acumular semanas completas sin overflow)
 */
export class FairnessScore {
  static readonly MIN = 0;
  static readonly MAX = 1000;
  static readonly ZERO = new FairnessScore(0);

  private constructor(public readonly value: number) {}

  static create(value: number): FairnessScore {
    if (value < FairnessScore.MIN || value > FairnessScore.MAX) {
      throw new Error(
        `FairnessScore must be between ${FairnessScore.MIN} and ${FairnessScore.MAX}, got ${value}`,
      );
    }
    return new FairnessScore(value);
  }

  /**
   * Suma dos scores. El resultado se clampea al máximo permitido.
   */
  add(other: FairnessScore): FairnessScore {
    const sum = this.value + other.value;
    return new FairnessScore(Math.min(sum, FairnessScore.MAX));
  }

  /**
   * Resta. El resultado se clampea al mínimo permitido.
   */
  subtract(other: FairnessScore): FairnessScore {
    const diff = this.value - other.value;
    return new FairnessScore(Math.max(diff, FairnessScore.MIN));
  }

  isHigherThan(other: FairnessScore): boolean {
    return this.value > other.value;
  }

  equals(other: FairnessScore): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return `FairnessScore(${this.value})`;
  }
}
