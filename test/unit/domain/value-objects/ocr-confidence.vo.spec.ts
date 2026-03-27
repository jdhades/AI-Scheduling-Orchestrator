import { OCRConfidence } from '../../../../src/domain/value-objects/ocr-confidence.vo';
import { DomainError } from '../../../../src/domain/errors/domain.error';

describe('OCRConfidence Value Object', () => {
  it('should create a valid OCRConfidence within bounds', () => {
    const conf = OCRConfidence.fromNumber(0.85);
    expect(conf.value).toBe(0.85);
    expect(conf.isSuspicious).toBe(false);
  });

  it('should mark confidence as suspicious if below 0.65', () => {
    const conf = OCRConfidence.fromNumber(0.5);
    expect(conf.value).toBe(0.5);
    expect(conf.isSuspicious).toBe(true);
  });

  it('should throw DomainError if confidence is below 0.0', () => {
    expect(() => OCRConfidence.fromNumber(-0.1)).toThrow(DomainError);
  });

  it('should throw DomainError if confidence is above 1.0', () => {
    expect(() => OCRConfidence.fromNumber(1.1)).toThrow(DomainError);
  });

  it('should correctly compare equality', () => {
    const conf1 = OCRConfidence.fromNumber(0.9);
    const conf2 = OCRConfidence.fromNumber(0.9);
    const conf3 = OCRConfidence.fromNumber(0.8);

    expect(conf1.equals(conf2)).toBe(true);
    expect(conf1.equals(conf3)).toBe(false);
  });
});
