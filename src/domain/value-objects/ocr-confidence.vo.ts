import { DomainError } from '../errors/domain.error';

/**
 * Default usado cuando el caller no override-a el threshold. Inteligente
 * y conservador para el path OCR de incidents (certificados médicos):
 * el motor OCR generalmente es confiable arriba de 0.65 — por debajo,
 * el certificado se manda a revisión manual.
 *
 * Coexiste con `companies.imports_confidence_threshold` (default 0.85),
 * que es per-tenant y aplica al subsistema de imports (más estricto
 * porque el vision LLM tiene más espacio para alucinar). No están
 * unificados a propósito — son contextos distintos.
 */
export const OCR_CONFIDENCE_DEFAULT_THRESHOLD = 0.65;

export class OCRConfidence {
  private readonly _value: number;
  private readonly _threshold: number;

  private constructor(value: number, threshold: number) {
    if (value < 0.0 || value > 1.0) {
      throw new DomainError('OCR Confidence must be between 0.0 and 1.0');
    }
    if (threshold < 0.0 || threshold > 1.0) {
      throw new DomainError('OCR threshold must be between 0.0 and 1.0');
    }
    this._value = value;
    this._threshold = threshold;
  }

  get value(): number {
    return this._value;
  }

  get isSuspicious(): boolean {
    return this._value < this._threshold;
  }

  /**
   * `threshold` opcional — si el caller tiene un valor per-tenant (ej.
   * desde `companies.ocr_confidence_threshold`), lo pasa acá. Sin él,
   * usa el default constant para no romper call sites legacy.
   */
  static fromNumber(
    value: number,
    threshold: number = OCR_CONFIDENCE_DEFAULT_THRESHOLD,
  ): OCRConfidence {
    return new OCRConfidence(value, threshold);
  }

  equals(other: OCRConfidence): boolean {
    return this._value === other.value;
  }
}
