export class PhoneNumber {
  /**
   * Sentinel cuando el employee no tiene phone real configurado —
   * caso post-PR 7 del sprint Auth: manager corporativo invitado por
   * email, phone_number NULL en BD. La VO acepta esta string para
   * no romper la reconstitución desde persistencia.
   */
  static readonly SENTINEL = '+0';

  private constructor(public readonly value: string) {}

  static create(value: string): PhoneNumber {
    if (value === PhoneNumber.SENTINEL) return new PhoneNumber(value);
    if (!/^\+[1-9]\d{1,14}$/.test(value)) {
      throw new Error('Invalid phone number');
    }
    return new PhoneNumber(value);
  }

  equals(other: PhoneNumber) {
    return this.value === other.value;
  }

  /** True si el employee no tiene phone configurado (signup email-only). */
  get isMissing(): boolean {
    return this.value === PhoneNumber.SENTINEL;
  }
}
