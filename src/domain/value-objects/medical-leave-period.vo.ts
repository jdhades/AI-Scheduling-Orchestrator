import { DomainError } from '../errors/domain.error';

export class MedicalLeavePeriod {
  private constructor(
    private readonly _startDate: Date,
    private readonly _endDate: Date,
  ) {
    if (this._endDate < this._startDate) {
      throw new DomainError(
        'Medical Leave End Date cannot be before Start Date',
      );
    }
  }

  get startDate(): Date {
    return this._startDate;
  }

  get endDate(): Date {
    return this._endDate;
  }

  get durationDays(): number {
    const timeDiff = this._endDate.getTime() - this._startDate.getTime();
    const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
    // +1 to make it inclusive. e.g. from Monday to Monday is 1 day.
    return daysDiff + 1;
  }

  static create(startDate: Date, endDate: Date): MedicalLeavePeriod {
    return new MedicalLeavePeriod(startDate, endDate);
  }

  equals(other: MedicalLeavePeriod): boolean {
    return (
      this._startDate.getTime() === other.startDate.getTime() &&
      this._endDate.getTime() === other.endDate.getTime()
    );
  }
}
