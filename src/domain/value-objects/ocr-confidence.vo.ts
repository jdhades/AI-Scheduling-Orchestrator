import { DomainError } from '../errors/domain.error';

export class OCRConfidence {
    private readonly _value: number;
    private readonly MIN_THRESHOLD = 0.65;

    private constructor(value: number) {
        if (value < 0.0 || value > 1.0) {
            throw new DomainError('OCR Confidence must be between 0.0 and 1.0');
        }
        this._value = value;
    }

    get value(): number {
        return this._value;
    }

    get isSuspicious(): boolean {
        return this._value < this.MIN_THRESHOLD;
    }

    static fromNumber(value: number): OCRConfidence {
        return new OCRConfidence(value);
    }

    equals(other: OCRConfidence): boolean {
        return this._value === other.value;
    }
}
