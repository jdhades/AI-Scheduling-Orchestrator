import {
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
import { randomUUID } from 'crypto';
import {
  SHIFT_SWAP_REQUEST_REPOSITORY,
  type IShiftSwapRequestRepository,
} from '../../domain/repositories/shift-swap-request.repository';
import {
  ShiftSwapRequest,
  type ShiftSwapRequestStatus,
} from '../../domain/aggregates/shift-swap-request.aggregate';

export class CreateShiftSwapRequestDto {
  requesterId!: string;
  targetId!: string;
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateShiftSwapRequestDto,
  ): Promise<object> {
    const req = ShiftSwapRequest.create({
      id: randomUUID(),
      companyId,
      requesterId: dto.requesterId,
      targetId: dto.targetId,
      assignmentId: dto.assignmentId ?? null,
    });
    await this.repo.save(req);
    return this.toDto(req);
  }

  @Get()
  async list(
    @Query('companyId') companyId: string,
    @Query('requesterId') requesterId?: string,
    @Query('targetId') targetId?: string,
    @Query('status') status?: string,
  ): Promise<object[]> {
    const statusList = status
      ? (status.split(',').map((s) => s.trim()) as ShiftSwapRequestStatus[])
      : undefined;
    const rows = await this.repo.findAllByCompany(companyId, {
      requesterId,
      targetId,
      status: statusList && statusList.length === 1 ? statusList[0] : statusList,
    });
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
      createdAt: r.createdAt.toISOString(),
    };
  }
}
