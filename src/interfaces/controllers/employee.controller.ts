import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { RegisterEmployeeCommand } from '../../application/commands/register-employee.command';
import { UpdateEmployeeCommand } from '../../application/commands/update-employee.command';
import { DeleteEmployeeCommand } from '../../application/commands/delete-employee.command';
import { GetEmployeeCalendarQuery } from '../../application/queries/get-employee-calendar.query';
import { GetCompanyEmployeesQuery } from '../../application/queries/get-company-employees.query';
import { GetEmployeeByIdQuery } from '../../application/queries/get-employee-by-id.query';
import { PhoneNumber } from '../../domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../domain/value-objects/experience-level.vo';
import { RegisterEmployeeDto } from '../dtos/register-employee.dto';
import { GetEmployeeCalendarDto } from '../dtos/get-employee-calendar.dto';
import { UpdateEmployeeDto } from '../dtos/update-employee.dto';

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
  ) {}

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
    const experience = new ExperienceLevel(
      dto.experienceMonths,
      DEFAULT_RANGES,
    );
    const employeeId = dto.employeeId ?? crypto.randomUUID();

    await this.commandBus.execute(
      new RegisterEmployeeCommand(
        employeeId,
        companyId,
        dto.name,
        phone,
        experience,
        dto.externalId,
      ),
    );

    return { employeeId };
  }

  /**
   * GET /employees
   * Devuelve todos los empleados de la empresa.
   */
  @Get()
  async getEmployees(
    @CurrentCompany() companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(new GetCompanyEmployeesQuery(companyId));
  }

  /**
   * GET /employees/:id
   * Devuelve un empleado puntual por id dentro del tenant actual.
   */
  @Get(':id')
  async getById(
    @Param('id') employeeId: string,
    @Headers('x-company-id') companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(new GetEmployeeByIdQuery(employeeId, companyId));
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

  /**
   * PATCH /employees/:id
   * Actualiza parcialmente un empleado. Los campos no enviados quedan
   * intactos. Para limpiar un nullable, mandar `null` explícito.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Param('id') employeeId: string,
    @Body() dto: UpdateEmployeeDto,
    @Headers('x-company-id') companyId: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new UpdateEmployeeCommand(employeeId, companyId, dto),
    );
  }

  /**
   * DELETE /employees/:id
   * Soft delete: marca `is_active=false` + `deleted_at=NOW()`.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('id') employeeId: string,
    @Headers('x-company-id') companyId: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new DeleteEmployeeCommand(employeeId, companyId),
    );
  }
}
