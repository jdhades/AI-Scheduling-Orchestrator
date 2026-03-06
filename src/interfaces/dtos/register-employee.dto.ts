import { IsString, IsNotEmpty, IsIn, IsNumber, Min } from 'class-validator';

/**
 * DTO: RegisterEmployeeDto
 *
 * Valida el body del POST /employees.
 * class-validator corre ANTES de que el command se construya,
 * por eso los VOs del dominio no necesitan validar formatos básicos dos veces.
 */
export class RegisterEmployeeDto {
    @IsString()
    @IsNotEmpty()
    employeeId: string;

    @IsString()
    @IsNotEmpty()
    phone: string;

    @IsNumber()
    @Min(0)
    experienceMonths: number;
}
