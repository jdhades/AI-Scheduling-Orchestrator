import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Headers,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { RegisterEmployeeCommand } from '../../application/commands/register-employee.command';
import { GetEmployeeCalendarQuery } from '../../application/queries/get-employee-calendar.query';
import { PhoneNumber } from '../../domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../domain/value-objects/experience-level.vo';
import { RegisterEmployeeDto } from '../dtos/register-employee.dto';
import { GetEmployeeCalendarDto } from '../dtos/get-employee-calendar.dto';

/**
 * EmployeeController — Interfaces Layer
 *
 * Responsabilidad: traducir HTTP ↔ Commands/Queries.
 * No contiene lógica de negocio. Construye VOs del dominio
 * y delega al CommandBus / QueryBus.
 *
 * Multi-tenant: El company_id se extrae del header X-Company-Id
 * (ya procesado por TenantMiddleware, disponible en TenantContext).
 * Aquí lo leemos del header directamente para construir los commands.
 *
 * 💡 Rangos de experiencia por defecto (configurable por empresa en Fase futura)
 */
const DEFAULT_RANGES = { junior: 6, intermediate: 24, senior: 999 };

@Controller('employees')
export class EmployeeController {
    constructor(
        private readonly commandBus: CommandBus,
        private readonly queryBus: QueryBus,
    ) { }

    /**
     * POST /employees
     * Registra un nuevo empleado en la empresa del tenant actual.
     */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    async register(
        @Body() dto: RegisterEmployeeDto,
        @Headers('x-company-id') companyId: string,
    ): Promise<{ employeeId: string }> {
        const phone = PhoneNumber.create(dto.phone);
        const experience = new ExperienceLevel(dto.experienceMonths, DEFAULT_RANGES);

        await this.commandBus.execute(
            new RegisterEmployeeCommand(
                dto.employeeId,
                companyId,
                phone,
                experience,
            ),
        );

        return { employeeId: dto.employeeId };
    }

    /**
     * GET /employees/:id/calendar?from=&to=
     * Retorna el calendario de turnos de un empleado en un rango de fechas.
     */
    @Get(':id/calendar')
    async getCalendar(
        @Param('id') employeeId: string,
        @Query() query: GetEmployeeCalendarDto,
        @Headers('x-company-id') companyId: string,
    ): Promise<unknown> {
        return this.queryBus.execute(
            new GetEmployeeCalendarQuery(
                employeeId,
                companyId,
                new Date(query.from),
                new Date(query.to),
            ),
        );
    }
}
