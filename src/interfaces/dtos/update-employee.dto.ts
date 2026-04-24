import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * DTO de PATCH /employees/:id
 *
 * Todos los campos son opcionales (PATCH). `null` en campos nullable
 * significa "limpiar el valor". `undefined` (campo omitido) deja el valor
 * intacto.
 */
export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  role?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  experienceMonths?: number;

  @IsOptional()
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  contractType?: string | null;

  @IsOptional()
  @IsNumber()
  maxHoursPerDay?: number | null;

  @IsOptional()
  @IsNumber()
  maxHoursPerWeek?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
