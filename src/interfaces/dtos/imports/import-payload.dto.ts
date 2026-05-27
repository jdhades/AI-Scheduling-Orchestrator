import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  IMPORT_SCHEMA_VERSION,
  type ImportSource,
} from '../../../domain/imports/import-payload.types';

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * DTO de entrada para `POST /imports/staging` y para el output del
 * extractor de Vía A/B/C. Validación strict — class-validator se asegura
 * que el payload sea consistente antes de stagear.
 *
 * Cualquier campo que falte por "el extractor no lo encontró" debe
 * omitirse (no mandar null, no mandar string vacío). Esto evita
 * confundir "el dato no existe" con "el dato es vacío".
 */

// ─── Sub-DTOs ──────────────────────────────────────────────────────────

class SourceMetadataDto {
  @IsISO8601() extractedAt!: string;
  @IsOptional() @IsString() @MaxLength(120) agentName?: string;
  @IsOptional() @IsString() @MaxLength(64) agentVersion?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

class LocationDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class DepartmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(120) locationExternalId?: string;
  @IsOptional() @IsString() @MaxLength(120) managerEmployeeExternalId?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class RoleDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class PayRateDto {
  @IsNumber() @Min(0) amount!: number;
  @IsString() @MaxLength(3) currency!: string;
  @IsIn(['hour', 'week', 'month']) period!: 'hour' | 'week' | 'month';
}

class EmployeeDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @Matches(ISO_DATE) hireDate?: string;
  @IsOptional()
  @IsIn(['full_time', 'part_time', 'contractor', 'intern'])
  employmentType?: 'full_time' | 'part_time' | 'contractor' | 'intern';
  @IsOptional() @ValidateNested() @Type(() => PayRateDto) payRate?: PayRateDto;
  @IsOptional() @IsString() @MaxLength(120) departmentExternalId?: string;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  roleExternalIds?: string[];
  @IsOptional() @IsInt() @Min(0) experienceMonths?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class ShiftDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsOptional() @IsString() @MaxLength(120) employeeExternalId?: string;
  @IsOptional() @IsString() @MaxLength(120) templateName?: string;
  @Matches(ISO_DATE) date!: string;
  @Matches(TIME_HHMM) startTime!: string;
  @Matches(TIME_HHMM) endTime!: string;
  @IsBoolean() crossesMidnight!: boolean;
  @IsOptional() @IsString() @MaxLength(120) locationExternalId?: string;
  @IsOptional() @IsString() @MaxLength(120) departmentExternalId?: string;
  @IsOptional() @IsString() @MaxLength(120) requiredRoleExternalId?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class AvailabilityWindowDto {
  @Matches(TIME_HHMM) startTime!: string;
  @Matches(TIME_HHMM) endTime!: string;
  @IsBoolean() available!: boolean;
}

class AvailabilityDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) employeeExternalId!: string;
  @IsInt() @Min(0) @Max(6) dayOfWeek!: number;
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
  @IsOptional() @Matches(ISO_DATE) effectiveFrom?: string;
  @IsOptional() @Matches(ISO_DATE) effectiveUntil?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class BreakDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsIn(['policy_global', 'policy_role', 'shift_specific']) scope!:
    | 'policy_global'
    | 'policy_role'
    | 'shift_specific';
  @IsOptional() @IsInt() @Min(0) triggerAfterMinutesWorked?: number;
  @IsInt() @Min(1) durationMinutes!: number;
  @IsBoolean() isPaid!: boolean;
  @IsOptional() @IsString() @MaxLength(120) roleExternalId?: string;
  @IsOptional() @IsString() @MaxLength(120) shiftExternalId?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class TimeOffDto {
  @IsString() @IsNotEmpty() @MaxLength(120) externalId!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) employeeExternalId!: string;
  @Matches(ISO_DATE) startDate!: string;
  @Matches(ISO_DATE) endDate!: string;
  @IsIn(['vacation', 'sick', 'personal', 'unpaid', 'other'])
  type!: 'vacation' | 'sick' | 'personal' | 'unpaid' | 'other';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsIn(['approved', 'pending', 'rejected'])
  status!: 'approved' | 'pending' | 'rejected';
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

class ImportDataDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LocationDto)
  locations?: LocationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DepartmentDto)
  departments?: DepartmentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RoleDto)
  roles?: RoleDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => EmployeeDto)
  employees?: EmployeeDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20000)
  @ValidateNested({ each: true })
  @Type(() => ShiftDto)
  shifts?: ShiftDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityDto)
  availability?: AvailabilityDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BreakDto)
  breaks?: BreakDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => TimeOffDto)
  timeOff?: TimeOffDto[];
}

class WarningDto {
  @IsIn(['info', 'warn', 'error']) severity!: 'info' | 'warn' | 'error';
  @IsString() @IsNotEmpty() @MaxLength(64) code!: string;
  @IsOptional() @IsString() @MaxLength(128) messageKey?: string;
  @IsString() @IsNotEmpty() @MaxLength(500) message!: string;
  @IsOptional() @IsObject() entityRef?: { entity: string; externalId: string };
  @IsOptional() @IsString() @MaxLength(500) suggestion?: string;
}

class UnresolvedReferenceDto {
  @IsString() @IsNotEmpty() fromEntity!: string;
  @IsString() @IsNotEmpty() fromExternalId!: string;
  @IsString() @IsNotEmpty() field!: string;
  @IsString() @MaxLength(200) rawValue!: string;
  @IsOptional() @IsArray() candidates?: Array<{
    id: string;
    label: string;
    confidence: number;
  }>;
}

// ─── Top-level ─────────────────────────────────────────────────────────

export class ImportPayloadDto {
  @IsIn([IMPORT_SCHEMA_VERSION], {
    message: `schemaVersion must be "${IMPORT_SCHEMA_VERSION}"`,
  })
  schemaVersion!: typeof IMPORT_SCHEMA_VERSION;

  @IsEnum(['upload_freeform', 'template_excel', 'external_agent'] as const, {
    message:
      'source must be one of upload_freeform | template_excel | external_agent',
  })
  source!: ImportSource;

  @ValidateNested()
  @Type(() => SourceMetadataDto)
  sourceMetadata!: SourceMetadataDto;

  @ValidateNested()
  @Type(() => ImportDataDto)
  data!: ImportDataDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => WarningDto)
  warnings?: WarningDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UnresolvedReferenceDto)
  unresolvedReferences?: UnresolvedReferenceDto[];
}
