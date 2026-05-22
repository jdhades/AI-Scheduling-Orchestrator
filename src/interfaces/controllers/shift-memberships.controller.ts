import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
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
import { IsOptional, IsUUID, Matches, ValidateIf } from 'class-validator';
import { randomUUID } from 'crypto';
import {
  SHIFT_MEMBERSHIP_REPOSITORY,
  type IShiftMembershipRepository,
} from '../../domain/repositories/shift-membership.repository';
import { ShiftMembership } from '../../domain/aggregates/shift-membership.aggregate';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateShiftMembershipDto {
  @IsUUID('loose')
  employeeId!: string;

  @IsUUID('loose')
  templateId!: string;

  /** YYYY-MM-DD */
  @Matches(ISO_DATE, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom!: string;

  /** YYYY-MM-DD o null/undefined = abierto */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(ISO_DATE, { message: 'effectiveUntil must be YYYY-MM-DD or null' })
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
    @CurrentCompany() companyId: string,
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
    @CurrentCompany() companyId: string,
  ): Promise<object> {
    const m = await this.membershipRepo.findById(id, companyId);
    if (!m) throw new NotFoundException(`ShiftMembership ${id} not found`);
    return this.toDto(m);
  }

  @Post()
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
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
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
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
