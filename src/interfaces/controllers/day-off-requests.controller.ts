import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import type { SupabaseClient } from '@supabase/supabase-js';
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
import { EmployeeNotifier } from '../notifications/employee-notifier.service';
import { AbsenceReportCreator } from '../../domain/services/absence-report-creator.service';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import {
  ApprovalShiftEnricher,
  type ApprovalShiftRef,
} from '../../application/services/approval-shift-enricher.service';

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
    private readonly employeeNotifier: EmployeeNotifier,
    private readonly shiftEnricher: ApprovalShiftEnricher,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
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
    if (user?.role === 'employee' && dto.employeeId !== user.employeeId) {
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
      status:
        statusList && statusList.length === 1 ? statusList[0] : statusList,
      fromDate,
      toDate,
    });
    const visible = managerEmployeeId
      ? await (async () => {
          const scope = await this.managerScope.getEmployeeIdsForManager(
            companyId,
            managerEmployeeId,
          );
          return rows.filter((r) => scope.has(r.employeeId));
        })()
      : rows;
    return this.enrichAndMap(companyId, visible);
  }

  /** Agrega a cada día-libre el turno que el empleado pierde ese día (o null). */
  private async enrichAndMap(
    companyId: string,
    rows: DayOffRequest[],
  ): Promise<object[]> {
    const shiftByKey = await this.shiftEnricher.byEmployeeDates(
      companyId,
      rows.map((r) => ({ employeeId: r.employeeId, date: r.date })),
    );
    return rows.map((r) =>
      this.toDto(r, shiftByKey.get(`${r.employeeId}|${r.date}`) ?? null),
    );
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    return (await this.enrichAndMap(companyId, [r]))[0];
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
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<{
    deletedAssignmentIds: string[];
    rulesCreated: Array<{
      startDate: string;
      endDate: string;
      ruleText: string;
    }>;
  }> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);

    const employee = await this.employeeRepo.findById(r.employeeId, companyId);
    if (!employee) {
      throw new NotFoundException(`Employee ${r.employeeId} not found`);
    }

    r.approve();
    await this.repo.save(r);
    // Atribución de la decisión (para reportes: quién y cuándo).
    await this.recordDecision(id, companyId, user?.employeeId ?? null);

    const sideEffects = await this.absenceCreator.applyUnavailability({
      companyId,
      employeeId: r.employeeId,
      employeeName: employee.name,
      startDate: r.date,
      endDate: r.date,
      reason: `día libre aprobado${r.reason ? `: ${r.reason}` : ''}`,
      createdByUserId: user?.userId ?? null,
      ruleSource: 'day-off',
    });

    // Notificar al empleado del approve por WhatsApp + push (deep-link a
    // solicitudes). Fire-and-forget — el aggregate ya está persistido.
    this.employeeNotifier.notify(companyId, r.employeeId, {
      titleKey: 'push.dayoff.approved.title',
      bodyKey: 'push.dayoff.approved.body',
      args: { date: r.date },
      data: { type: 'approval' },
    });

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
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    r.reject();
    await this.repo.save(r);
    await this.recordDecision(id, companyId, user?.employeeId ?? null);
    this.employeeNotifier.notify(companyId, r.employeeId, {
      titleKey: 'push.dayoff.rejected.title',
      bodyKey: 'push.dayoff.rejected.body',
      args: { date: r.date },
      data: { type: 'approval' },
    });
  }

  /** DELETE /:id — el empleado cancela su propio pedido mientras esté pending. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!user?.employeeId) throw new ForbiddenException('No employee linked');
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    if (r.employeeId !== user.employeeId) {
      throw new ForbiddenException('Cannot cancel another employee request');
    }
    if (r.status !== 'pending') {
      throw new BadRequestException('Request already resolved');
    }
    // Soft-delete: el pedido cancelado se conserva para reportes (pidió y
    // retiró). El listado filtra deleted_at IS NULL.
    await this.supabase
      .from('day_off_requests')
      .update({ deleted_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', id);
  }

  /** Registra quién y cuándo decidió (approve/reject) — para reportes. */
  private async recordDecision(
    id: string,
    companyId: string,
    decidedBy: string | null,
  ): Promise<void> {
    await this.supabase
      .from('day_off_requests')
      .update({ decided_by: decidedBy, decided_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', id);
  }

  private toDto(
    r: DayOffRequest,
    shift: ApprovalShiftRef | null = null,
  ): object {
    return {
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      date: r.date,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      /** Turno que el empleado pierde ese día, o null = sin turno. */
      shift,
    };
  }
}
