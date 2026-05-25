import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  ENTITY_AUDIT_SERVICE,
  computeChangeSet,
  snapshotAsChangeSet,
  type IEntityAuditService,
} from '../../domain/audit/entity-audit.service';
import { Inject } from '@nestjs/common';
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
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  private auditFields = [
    'name',
    'phone',
    'experienceMonths',
    'locale',
    'role',
    'departmentId',
  ] as const;

  /**
   * POST /employees
   * Registra un nuevo empleado en la empresa del tenant actual.
   */
  @Post()
  @Requires('employees:write')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterEmployeeDto,
    @Headers('x-company-id') companyId: string,
    @CurrentUser() user: AuthContext | undefined,
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

    const created = await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null);
    if (created) {
      await this.audit.log({
        companyId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'create',
        changes: snapshotAsChangeSet(
          this.pickAuditFields(created as Record<string, unknown>),
          'create',
        ),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }

    return { employeeId };
  }

  private pickAuditFields(
    emp: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.auditFields.reduce<Record<string, unknown>>((acc, f) => {
      acc[f] = emp[f] ?? null;
      return acc;
    }, {});
  }

  /**
   * GET /employees
   * Devuelve todos los empleados de la empresa.
   */
  @Get()
  async getEmployees(@CurrentCompany() companyId: string): Promise<unknown> {
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
    return this.queryBus.execute(
      new GetEmployeeByIdQuery(employeeId, companyId),
    );
  }

  /**
   * GET /employees/:id/calendar?from=&to=
   * Retorna el calendario de turnos de un empleado en un rango de fechas.
   */
  @Get(':id/calendar')
  async getCalendar(
    @Param('id') employeeId: string,
    @Query() query: GetEmployeeCalendarDto,
    @CurrentCompany() companyId: string,
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
  @Requires('employees:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Param('id') employeeId: string,
    @Body() dto: UpdateEmployeeDto,
    @Headers('x-company-id') companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const before = (await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null)) as Record<string, unknown> | null;
    await this.commandBus.execute(
      new UpdateEmployeeCommand(employeeId, companyId, dto),
    );
    const after = (await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null)) as Record<string, unknown> | null;
    if (before && after) {
      const beforeSnap = this.pickAuditFields(before) as Record<
        (typeof this.auditFields)[number],
        unknown
      >;
      const afterSnap = this.pickAuditFields(after) as Record<
        (typeof this.auditFields)[number],
        unknown
      >;
      await this.audit.log({
        companyId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'update',
        changes: computeChangeSet(beforeSnap, afterSnap, this.auditFields),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
  }

  /**
   * DELETE /employees/:id
   * Soft delete: marca `is_active=false` + `deleted_at=NOW()`.
   */
  @Delete(':id')
  @Requires('employees:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('id') employeeId: string,
    @Headers('x-company-id') companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const before = (await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null)) as Record<string, unknown> | null;
    await this.commandBus.execute(
      new DeleteEmployeeCommand(employeeId, companyId),
    );
    if (before) {
      await this.audit.log({
        companyId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'delete',
        changes: snapshotAsChangeSet(this.pickAuditFields(before), 'delete'),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
  }
}
