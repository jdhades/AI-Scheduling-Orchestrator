import {
  BadRequestException,
  Body,
  Controller,
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
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateShiftSwapRequestDto,
  ): Promise<object> {
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
    @Query('companyId') companyId: string,
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
      status: statusList && statusList.length === 1 ? statusList[0] : statusList,
    });
    // Phase 15.2 — filter por manager: si vino el query, filtramos a los
    // requests cuyo `requesterId` esté en el scope del manager (su depto
    // + depts sin manager asignado).
    if (managerEmployeeId) {
      const scope = await this.managerScope.getEmployeeIdsForManager(
        companyId,
        managerEmployeeId,
      );
      return rows
        .filter((r) => scope.has(r.requesterId))
        .map((r) => this.toDto(r));
    }
    return rows.map((r) => this.toDto(r));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<object> {
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    return this.toDto(req);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<void> {
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    req.accept();
    await this.repo.save(req);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<void> {
    const req = await this.repo.findById(id, companyId);
    if (!req) throw new NotFoundException(`ShiftSwapRequest ${id} not found`);
    req.reject();
    await this.repo.save(req);
  }

  private toDto(r: ShiftSwapRequest): object {
    return {
      id: r.id,
      companyId: r.companyId,
      requesterId: r.requesterId,
      targetId: r.targetId,
      assignmentId: r.assignmentId,
      status: r.status,
      approvedBy: r.approvedBy,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
