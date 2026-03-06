import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * CreateSemanticRuleDto — DTO para POST /rules/semantic
 *
 * Validaciones:
 *   - ruleText: entre 10 y 1000 caracteres (mismo límite que el dominio)
 *   - priorityLevel: 1 (legal), 2 (semantic), 3 (preference)
 *   - ruleType: restriction | preference | requirement
 *   - createdBy: UUID del empleado Admin que crea la regla (opcional)
 */
export class CreateSemanticRuleDto {
    @IsString()
    @IsNotEmpty()
    @MinLength(10, { message: 'La regla debe tener al menos 10 caracteres' })
    @MaxLength(1000, { message: 'La regla no puede superar los 1000 caracteres' })
    ruleText: string;

    @IsEnum([1, 2, 3], { message: 'priorityLevel debe ser 1 (legal), 2 (semantic) o 3 (preference)' })
    priorityLevel: 1 | 2 | 3;

    @IsEnum(['restriction', 'preference', 'requirement'], {
        message: 'ruleType debe ser restriction, preference o requirement',
    })
    ruleType: 'restriction' | 'preference' | 'requirement';

    @IsOptional()
    @IsUUID()
    createdBy?: string;

    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;
}
