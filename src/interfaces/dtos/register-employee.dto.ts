import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
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
  @IsString()
  employeeId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsNumber()
  @Min(0)
  experienceMonths: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  externalId?: string;
}
