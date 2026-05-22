import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { randomUUID } from 'crypto';
import {
  DAY_OFF_REQUEST_REPOSITORY,
  type IDayOffRequestRepository,
} from '../../domain/repositories/day-off-request.repository';
import {
  DayOffRequest,
  type DayOffRequestStatus,
} from '../../domain/aggregates/day-off-request.aggregate';
import { ManagerScopeService } from '../../application/services/manager-scope.service';
import { ManagerNotificationService } from '../../application/services/manager-notification.service';
import { AbsenceReportCreator } from '../../domain/services/absence-report-creator.service';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateDayOffRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  /** YYYY-MM-DD */
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

/**
 * DayOffRequestsController
 *
 * POST /day-off-requests                — crear pedido (pending)
 * GET  /day-off-requests                — listar (filtros: employeeId, status, from, to)
 * GET  /day-off-requests/:id            — uno
 * POST /day-off-requests/:id/approve    — aprobar (pending → approved)
 * POST /day-off-requests/:id/reject     — rechazar (pending → rejected)
 */
@Controller('day-off-requests')
export class DayOffRequestsController {
  constructor(
    @Inject(DAY_OFF_REQUEST_REPOSITORY)
    private readonly repo: IDayOffRequestRepository,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly managerScope: ManagerScopeService,
    private readonly absenceCreator: AbsenceReportCreator,
    private readonly managerNotifications: ManagerNotificationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateDayOffRequestDto,
  ): Promise<object> {
    // Domain guard: un employee solo puede pedir SU propio día libre.
    // Manager/owner pueden crear pedidos para otros (caso legítimo:
    // gestión de equipo). Aprobar/rechazar va por endpoints separados
    // con @Requires('dayoffs:approve').
    if (
      user?.role === 'employee' &&
      dto.employeeId !== user.employeeId
    ) {
      throw new ForbiddenException(
        'Cannot file day-off requests on behalf of another employee',
      );
    }
    const req = DayOffRequest.create({
      id: randomUUID(),
      companyId,
      employeeId: dto.employeeId,
      date: dto.date,
      reason: dto.reason,
    });
    await this.repo.save(req);
    return this.toDto(req);
  }

  @Get()
  async list(
    @CurrentCompany() companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('from') fromDate?: string,
    @Query('to') toDate?: string,
    @Query('managerEmployeeId') managerEmployeeId?: string,
  ): Promise<object[]> {
    const statusList = status
      ? (status.split(',').map((s) => s.trim()) as DayOffRequestStatus[])
      : undefined;
    const rows = await this.repo.findAllByCompany(companyId, {
      employeeId,
      status: statusList && statusList.length === 1 ? statusList[0] : statusList,
      fromDate,
      toDate,
    });
    if (managerEmployeeId) {
      const scope = await this.managerScope.getEmployeeIdsForManager(
        companyId,
        managerEmployeeId,
      );
      return rows
        .filter((r) => scope.has(r.employeeId))
        .map((r) => this.toDto(r));
    }
    return rows.map((r) => this.toDto(r));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    return this.toDto(r);
  }

  /**
   * POST /day-off-requests/:id/approve
   *
   * Phase 18.3 — además de marcar `status='approved'`, dispara el
   * side-effect de unavailability (igual que absence_report):
   *   - Si hay assignment ese día → lo borra.
   *   - Si no hay → crea una semantic rule para que el scheduler
   *     respete el día libre cuando se genere la semana.
   *
   * El reason de la rule es "día libre aprobado: <razón original>".
   */
  @Post(':id/approve')
  @Requires('dayoffs:approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<{
    deletedAssignmentIds: string[];
    rulesCreated: Array<{ startDate: string; endDate: string; ruleText: string }>;
  }> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);

    const employee = await this.employeeRepo.findById(r.employeeId, companyId);
    if (!employee) {
      throw new NotFoundException(`Employee ${r.employeeId} not found`);
    }

    r.approve();
    await this.repo.save(r);

    const sideEffects = await this.absenceCreator.applyUnavailability({
      companyId,
      employeeId: r.employeeId,
      employeeName: employee.name,
      startDate: r.date,
      endDate: r.date,
      reason: `día libre aprobado${r.reason ? `: ${r.reason}` : ''}`,
      // No JWT todavía → no podemos identificar al manager que aprueba.
      // La rule queda con created_by NULL; la fuente queda en metadata.
      createdByUserId: null,
      ruleSource: 'day-off',
    });

    // Notificar al empleado del approve. Fire-and-forget — el aggregate
    // ya está persistido; un fail del provider no debe romper el endpoint.
    void this.managerNotifications.notifyEmployee(
      companyId,
      r.employeeId,
      `Tu pedido de día libre para el ${r.date} fue APROBADO.`,
    );

    return {
      deletedAssignmentIds: sideEffects.deleted.map((d) => d.id),
      rulesCreated: sideEffects.rulesCreated,
    };
  }

  @Post(':id/reject')
  @Requires('dayoffs:approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    r.reject();
    await this.repo.save(r);
    void this.managerNotifications.notifyEmployee(
      companyId,
      r.employeeId,
      `Tu pedido de día libre para el ${r.date} fue rechazado por tu manager.`,
    );
  }

  private toDto(r: DayOffRequest): object {
    return {
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      date: r.date,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
