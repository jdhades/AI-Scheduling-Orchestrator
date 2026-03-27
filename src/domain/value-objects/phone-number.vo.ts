export class PhoneNumber {
  private constructor(public readonly value: string) {}
  static create(value: string): PhoneNumber {
    if (!/^\+[1-9]\d{1,14}$/.test(value)) {
      throw new Error('Invalid phone number');
    }
    return new PhoneNumber(value);
  }
  equals(other: PhoneNumber) {
    return this.value === other.value;
  }
}
