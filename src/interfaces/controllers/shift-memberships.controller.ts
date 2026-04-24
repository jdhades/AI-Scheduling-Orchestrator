import {
  Body,
  Controller,
  Delete,
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
  SHIFT_MEMBERSHIP_REPOSITORY,
  type IShiftMembershipRepository,
} from '../../domain/repositories/shift-membership.repository';
import { ShiftMembership } from '../../domain/aggregates/shift-membership.aggregate';

export class CreateShiftMembershipDto {
  employeeId!: string;
  templateId!: string;
  /** YYYY-MM-DD */
  effectiveFrom!: string;
  /** YYYY-MM-DD o null/undefined = abierto */
  effectiveUntil?: string | null;
}

/**
 * ShiftMembershipsController
 *
 * GET    /shift-memberships                     — lista (con filtros opcionales)
 * GET    /shift-memberships/:id                 — obtener una membership
 * POST   /shift-memberships                     — crear membership
 * DELETE /shift-memberships/:id                 — soft delete
 *
 * Sin PATCH: para cambiar una membership, borrar y crear de nuevo — así el
 * histórico queda limpio con effective_from/until auditables.
 */
@Controller('shift-memberships')
export class ShiftMembershipsController {
  constructor(
    @Inject(SHIFT_MEMBERSHIP_REPOSITORY)
    private readonly membershipRepo: IShiftMembershipRepository,
  ) {}

  @Get()
  async list(
    @Query('companyId') companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('templateId') templateId?: string,
    @Query('date') date?: string,
  ): Promise<object[]> {
    const rows = await this.membershipRepo.findAllByCompany(companyId, {
      employeeId,
      templateId,
      date,
    });
    return rows.map((m) => this.toDto(m));
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<object> {
    const m = await this.membershipRepo.findById(id, companyId);
    if (!m) throw new NotFoundException(`ShiftMembership ${id} not found`);
    return this.toDto(m);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Query('companyId') companyId: string,
    @Body() dto: CreateShiftMembershipDto,
  ): Promise<object> {
    const membership = ShiftMembership.create({
      id: randomUUID(),
      companyId,
      employeeId: dto.employeeId,
      templateId: dto.templateId,
      effectiveFrom: dto.effectiveFrom,
      effectiveUntil: dto.effectiveUntil ?? null,
    });
    await this.membershipRepo.save(membership);
    return this.toDto(membership);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ): Promise<void> {
    const existing = await this.membershipRepo.findById(id, companyId);
    if (!existing) throw new NotFoundException(`ShiftMembership ${id} not found`);
    await this.membershipRepo.delete(id, companyId);
  }

  private toDto(m: ShiftMembership): object {
    return {
      id: m.id,
      companyId: m.companyId,
      employeeId: m.employeeId,
      templateId: m.templateId,
      effectiveFrom: m.effectiveFrom,
      effectiveUntil: m.effectiveUntil,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
