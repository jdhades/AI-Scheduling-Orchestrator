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
import { IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { randomUUID } from 'crypto';
import {
  SHIFT_SWAP_REQUEST_REPOSITORY,
  type IShiftSwapRequestRepository,
} from '../../domain/repositories/shift-swap-request.repository';
import {
  ShiftSwapRequest,
  type ShiftSwapRequestStatus,
} from '../../domain/aggregates/shift-swap-request.aggregate';
import { ManagerScopeService } from '../../application/services/manager-scope.service';
import { EmployeeNotifier } from '../notifications/employee-notifier.service';
import {
  ApprovalShiftEnricher,
  type ApprovalShiftRef,
} from '../../application/services/approval-shift-enricher.service';

export class CreateShiftSwapRequestDto {
  @IsString()
  @IsNotEmpty()
  requesterId!: string;

  @IsString()
  @IsNotEmpty()
  targetId!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  assignmentId?: string | null;
}

/**
 * ShiftSwapRequestsController
 *
 * POST /shift-swap-requests                — crear un pedido (status=pending)
 * GET  /shift-swap-requests                — listar (filtros: status, requester, target)
 * GET  /shift-swap-requests/:id            — uno
 * POST /shift-swap-requests/:id/approve    — marcar accepted (decisión solamente;
 *                                             el swap físico de assignments queda
 *                                             fuera de este endpoint)
 * POST /shift-swap-requests/:id/reject     — marcar rejected
 */
@Controller('shift-swap-requests')
export class ShiftSwapRequestsController {
  constructor(
    @Inject(SHIFT_SWAP_REQUEST_REPOSITORY)
    private readonly repo: IShiftSwapRequestRepository,
    private readonly managerScope: ManagerScopeService,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly employeeNotifier: EmployeeNotifier,
    private readonly shiftEnricher: ApprovalShiftEnricher,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateShiftSwapRequestDto,
  ): Promise<object> {
    // Domain guard: solo el propio empleado puede pedir un swap de SU
    // shift — managers no inician swaps (aprueban/rechazan via
    // /:id/approve|/reject con @Requires('swaps:approve')). Owner
    // queda excluido del check también: no hay caso legítimo para que
    // el owner cree un swap en nombre de alguien.
    if (user?.employeeId && dto.requesterId !== user.employeeId) {
      throw new ForbiddenException(
        'Can only request swaps for your own shifts',
      );
    }
    // Phase 15.2 — cross-department swap guard. Si los dos employees
    // pertenecen a depts distintos rechazamos: el manager de cada depto
    // tendría que coordinar y la auditoría se vuelve confusa. Si uno (o
    // los dos) no tiene depto, lo permitimos (legacy / managers tenant-
    // wide).
    const empPair = await this.supabase
      .from('employees')
      .select('id, department_id, company_id')
      .eq('company_id', companyId)
      .in('id', [dto.requesterId, dto.targetId]);
    if (empPair.error) {
      throw new Error(empPair.error.message);
    }
    const employees = empPair.data ?? [];
    const requester = employees.find((e) => e.id === dto.requesterId);
    const target = employees.find((e) => e.id === dto.targetId);
    if (!requester) {
      throw new BadRequestException(
        `Requester ${dto.requesterId} not found in company`,
      );
    }
    if (!target) {
      throw new BadRequestException(
        `Target ${dto.targetId} not found in company`,
      );
    }
    if (
      requester.department_id &&
      target.department_id &&
      requester.department_id !== target.department_id
    ) {
      throw new BadRequestException(
        'Cross-department swaps are not supported. Requester and target must belong to the same department.',
      );
    }

    const req = ShiftSwapRequest.create({
      id: randomUUID(),
      companyId,
      requesterId: dto.requesterId,
      targetId: dto.targetId,
      assignmentId: dto.assignmentId ?? null,
    });

    // Phase 15.3 — auto-approve toggle. Si el depto del requester tiene
    // `swap_auto_approve = true`, marcamos el request como accepted antes
    // de persistir. Tag `approved_by = system:auto-approve` para que el
    // panel/audit lo distinga de aprobaciones manuales.
    if (requester.department_id) {
      const dept = await this.supabase
        .from('departments')
        .select('swap_auto_approve')
        .eq('id', requester.department_id)
        .eq('company_id', companyId)
        .maybeSingle();
      if (dept.error) {
        throw new Error(dept.error.message);
      }
      if (dept.data?.swap_auto_approve === true) {
        req.accept('system:auto-approve');
      }
    }

    await this.repo.save(req);
    return this.toDto(req);
  }

  @Get()
  async list(
    @CurrentCompany() companyId: string,
    @Query('requesterId') requesterId?: string,
    @Query('targetId') targetId?: string,
    @Query('status') status?: string,
    @Query('managerEmployeeId') managerEmployeeId?: string,
  ): Promise<object[]> {
    const statusList = status
      ? (status.split(',').map((s) => s.trim()) as ShiftSwapRequestStatus[])
      : undefined;
    const rows = await this.repo.findAllByCompany(companyId, {
      requesterId,
      targetId,
      status:
        statusList && statusList.length === 1 ? statusList[0] : statusList,
    });
    // Phase 15.2 — filter por manager: si vino el query, filtramos a los
    // requests cuyo `requesterId` esté en el scope del manager (su depto
    // + depts sin manager asignado).
    const visible = managerEmployeeId
      ? await (async () => {
          const scope = await this.managerScope.getEmployeeIdsForManager(
            companyId,
            managerEmployeeId,
          );
          return rows.filter((r) => scope.has(r.requesterId));
        })()
      : rows;
    return this.enrichAndMap(companyId, visible);
  }

  /**
   * Agrega a cada swap el turno que se intercambia (del requester) y si el
   * target tiene turno ese día (null = sin turno → al aprobar, el target
   * simplemente toma el turno y el requester queda libre).
   */
  private async enrichAndMap(
    companyId: string,
    rows: ShiftSwapRequest[],
  ): Promise<object[]> {
    const shiftByAssignment = await this.shiftEnricher.byAssignmentIds(
      companyId,
      rows.map((r) => r.assignmentId),
    );
    const targetPairs = rows
      .map((r) => {
        const shift = r.assignmentId
          ? shiftByAssignment.get(r.assignmentId)
          : undefined;
        return shift ? { employeeId: r.targetId, date: shift.date } : null;
      })
      .filter((p): p is { employeeId: string; date: string } => p !== null);
    const targetShiftByKey = await this.shiftEnricher.byEmployeeDates(
      companyId,
      targetPairs,
    );
    return rows.map((r) => {
      const shift = r.assignmentId
        ? (shiftByAssignment.get(r.assignmentId) ?? null)
        : null;
      const targetShift = shift
        ? (targetShiftByKey.get(`${r.targetId}|${shift.date}`) ?? null)
        : null;
      return this.toDto(r, shift, targetShift);
    });
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    return (await this.enrichAndMap(companyId, [req]))[0];
  }

  @Post(':id/approve')
  @Requires('swaps:approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    req.accept();
    await this.repo.save(req);
    await this.recordDecision(id, companyId, user?.employeeId ?? null);
    // Avisar a ambas partes — el solicitante y el target del swap.
    this.employeeNotifier.notify(companyId, req.requesterId, {
      titleKey: 'push.swap.approved.title',
      bodyKey: 'push.swap.approved.body',
      data: { type: 'approval' },
    });
    this.employeeNotifier.notify(companyId, req.targetId, {
      titleKey: 'push.swap.approvedTarget.title',
      bodyKey: 'push.swap.approvedTarget.body',
      data: { type: 'approval' },
    });
  }

  @Post(':id/reject')
  @Requires('swaps:approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    req.reject();
    await this.repo.save(req);
    await this.recordDecision(id, companyId, user?.employeeId ?? null);
    this.employeeNotifier.notify(companyId, req.requesterId, {
      titleKey: 'push.swap.rejected.title',
      bodyKey: 'push.swap.rejected.body',
      data: { type: 'approval' },
    });
  }

  /** Atribución de la decisión (approved_by + decided_at) para reportes. */
  private async recordDecision(
    id: string,
    companyId: string,
    decidedBy: string | null,
  ): Promise<void> {
    await this.supabase
      .from('shift_swap_requests')
      .update({ approved_by: decidedBy, decided_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', id);
  }

  /** DELETE /:id — el solicitante cancela su propio pedido mientras esté pending. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!user?.employeeId) throw new ForbiddenException('No employee linked');
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    if (req.requesterId !== user.employeeId) {
      throw new ForbiddenException('Cannot cancel another employee request');
    }
    if (req.status !== 'pending') {
      throw new BadRequestException('Request already resolved');
    }
    // Soft-delete: conservar el pedido cancelado para reportes.
    await this.supabase
      .from('shift_swap_requests')
      .update({ deleted_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', id);
  }

  private toDto(
    r: ShiftSwapRequest,
    shift: ApprovalShiftRef | null = null,
    targetShift: ApprovalShiftRef | null = null,
  ): object {
    return {
      id: r.id,
      companyId: r.companyId,
      requesterId: r.requesterId,
      targetId: r.targetId,
      assignmentId: r.assignmentId,
      status: r.status,
      approvedBy: r.approvedBy,
      createdAt: r.createdAt.toISOString(),
      /** Turno que se intercambia (del requester). */
      shift,
      /** Turno del target ese día, o null = sin turno. */
      targetShift,
    };
  }
}
