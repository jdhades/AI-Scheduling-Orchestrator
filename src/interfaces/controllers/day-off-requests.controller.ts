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
  DAY_OFF_REQUEST_REPOSITORY,
  type IDayOffRequestRepository,
} from '../../domain/repositories/day-off-request.repository';
import {
  DayOffRequest,
  type DayOffRequestStatus,
} from '../../domain/aggregates/day-off-request.aggregate';

export class CreateDayOffRequestDto {
  employeeId!: string;
  /** YYYY-MM-DD */
  date!: string;
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateDayOffRequestDto,
  ): Promise<object> {
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
    @Query('companyId') companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('from') fromDate?: string,
    @Query('to') toDate?: string,
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
    return rows.map((r) => this.toDto(r));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<object> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    return this.toDto(r);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<void> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    r.approve();
    await this.repo.save(r);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<void> {
    const r = await this.repo.findById(id, companyId);
    if (!r) throw new NotFoundException(`DayOffRequest ${id} not found`);
    r.reject();
    await this.repo.save(r);
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
