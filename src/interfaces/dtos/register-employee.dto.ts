import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * DTO: RegisterEmployeeDto
 *
 * Body del POST /employees. El UUID interno (PK) se genera server-side si
 * no llega `employeeId` — sólo el seed lo provee. El `externalId` (legajo /
 * id de nómina) es opcional y separado del PK.
 */
export class RegisterEmployeeDto {
  @IsOptional()
  @IsUUID('loose')
  employeeId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  /**
   * Email opcional. Si se provee, el backend automáticamente dispara una
   * invitación al crear el employee (auth_invitations + Resend mail) para
   * que pueda definir su password y loguearse. Si no se provee, el employee
   * queda como registro HR sin posibilidad de login.
   */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsNumber()
  @Min(0)
  experienceMonths: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  externalId?: string;
}
