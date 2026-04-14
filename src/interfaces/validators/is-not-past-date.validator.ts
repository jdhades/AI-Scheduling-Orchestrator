import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * IsNotPastDate — custom class-validator decorator
 *
 * Rejects any ISO date string that falls before today (UTC midnight).
 * Applied to weekStart fields so past schedules can never be generated.
 */
@ValidatorConstraint({ name: 'isNotPastDate', async: false })
export class IsNotPastDateConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const date = new Date(value);
    return !isNaN(date.getTime()) && date >= today;
  }

  defaultMessage(): string {
    const today = new Date().toISOString().split('T')[0];
    return `weekStart must be today or a future date (received past date; today is ${today} UTC)`;
  }
}

export function IsNotPastDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsNotPastDateConstraint,
    });
  };
}
