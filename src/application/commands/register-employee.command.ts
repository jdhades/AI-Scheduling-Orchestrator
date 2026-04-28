import { PhoneNumber } from '../../domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../domain/value-objects/experience-level.vo';

/**
 * Command: RegisterEmployee
 *
 * Encapsula los datos necesarios para registrar un nuevo empleado.
 * El command es inmutable — representa una intención de cambio de estado.
 */
export class RegisterEmployeeCommand {
  constructor(
    public readonly employeeId: string,
    public readonly companyId: string,
    public readonly name: string,
    public readonly phone: PhoneNumber,
    public readonly experience: ExperienceLevel,
    public readonly externalId?: string,
  ) {}
}
