import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * PATCH /rules/semantic/:id — actualiza metadata.
 * NO acepta rule_text (usar el endpoint /text para eso).
 */
export class UpdateSemanticRuleMetadataDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  priorityLevel?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** ISO-8601 string o null para limpiar vencimiento. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  @IsOptional()
  @IsString()
  branchId?: string | null;

  @IsOptional()
  @IsString()
  departmentId?: string | null;
}

/**
 * PATCH /rules/semantic/:id/text — cambia el texto y regenera embedding
 * + estructura (operación cara).
 */
export class UpdateSemanticRuleTextDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  ruleText!: string;
}
