import { randomUUID } from 'crypto';
import { DomainError } from '../errors/domain.error';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IncidentId {
  private readonly _value: string;

  private constructor(value: string) {
    if (!UUID_REGEX.test(value)) {
      throw new DomainError('Invalid Incident ID format');
    }
    this._value = value;
  }

  get value(): string {
    return this._value;
  }

  static create(): IncidentId {
    return new IncidentId(randomUUID());
  }

  static fromString(value: string): IncidentId {
    return new IncidentId(value);
  }

  equals(other: IncidentId): boolean {
    return this._value === other.value;
  }
}
