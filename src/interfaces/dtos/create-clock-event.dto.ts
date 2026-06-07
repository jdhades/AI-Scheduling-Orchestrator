import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ClockGpsDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;

  /** Reported horizontal accuracy in meters. */
  @IsNumber()
  accuracy!: number;

  /** Supabase Storage reference for the verification selfie. */
  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class CreateClockEventDto {
  /** Client-generated idempotency key (offline-safe). */
  @IsString()
  @IsNotEmpty()
  clientUuid!: string;

  @IsIn(['in', 'out', 'break_start', 'break_end'])
  type!: 'in' | 'out' | 'break_start' | 'break_end';

  /** When the punch happened, captured on device. */
  @IsISO8601()
  occurredAt!: string;

  @IsOptional()
  @IsString()
  shiftAssignmentId?: string;

  /** Locación contra la que se valida el geofence (feature 'locations'). */
  @IsOptional()
  @IsString()
  locationId?: string;

  @ValidateNested()
  @Type(() => ClockGpsDto)
  gps!: ClockGpsDto;
}
