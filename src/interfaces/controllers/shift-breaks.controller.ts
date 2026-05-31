import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { randomUUID } from 'crypto';
import { Inject } from '@nestjs/common';
import {
  ShiftBreakManager,
  BreakConflictError,
} from '../../domain/services/shift-break-manager.service';
import {
  SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
  type IShiftAssignmentBreakRepository,
} from '../../domain/repositories/shift-assignment-break.repository';
import {
  SHIFT_TEMPLATE_BREAK_REPOSITORY,
  type IShiftTemplateBreakRepository,
} from '../../domain/repositories/shift-template-break.repository';
import { ShiftTemplateBreak } from '../../domain/aggregates/shift-template-break.aggregate';
import type { ShiftAssignmentBreak } from '../../domain/aggregates/shift-assignment-break.aggregate';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  ENTITY_AUDIT_SERVICE,
  type IEntityAuditService,
  computeChangeSet,
  snapshotAsChangeSet,
} from '../../domain/audit/entity-audit.service';

// ─── DTOs ─────────────────────────────────────────────────────────────

export class CreateAssignmentBreakDto {
  @IsISO8601()
  startTime!: string;

  @IsISO8601()
  endTime!: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class UpdateAssignmentBreakDto {
  @IsOptional()
  @IsISO8601()
  startTime?: string;

  @IsOptional()
  @IsISO8601()
  endTime?: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class CreateTemplateBreakDto {
  @IsInt()
  @Min(0)
  startOffsetMinutes!: number;

  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

interface AssignmentBreakResponse {
  id: string;
  assignmentId: string;
  startTime: string;
  endTime: string;
  isPaid: boolean;
  reason: string | null;
  createdAt: string;
}

interface TemplateBreakResponse {
  id: string;
  templateId: string;
  startOffsetMinutes: number;
  durationMinutes: number;
  isPaid: boolean;
  reason: string | null;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const toAssignmentBreakDto = (
  b: ShiftAssignmentBreak,
): AssignmentBreakResponse => ({
  id: b.id,
  assignmentId: b.assignmentId,
  startTime: b.startTime.toISOString(),
  endTime: b.endTime.toISOString(),
  isPaid: b.isPaid,
  reason: b.reason,
  createdAt: b.createdAt.toISOString(),
});

const toTemplateBreakDto = (b: ShiftTemplateBreak): TemplateBreakResponse => ({
  id: b.id,
  templateId: b.templateId,
  startOffsetMinutes: b.startOffsetMinutes,
  durationMinutes: b.durationMinutes,
  isPaid: b.isPaid,
  reason: b.reason,
  createdAt: b.createdAt.toISOString(),
});

const handleBreakConflict = (err: unknown): never => {
  if (err instanceof BreakConflictError) {
    if (
      err.reason === 'assignment_not_found' ||
      err.reason === 'break_not_found'
    ) {
      throw new NotFoundException({
        error: err.reason,
        message: err.detail,
        ...(err.meta ?? {}),
      });
    }
    throw new ConflictException({
      error: err.reason,
      message: err.detail,
      ...(err.meta ?? {}),
    });
  }
  throw err;
};

/**
 * ShiftBreaksController
 *
 * Dos resource trees acoplados:
 *
 *   /shift-assignments/:assignmentId/breaks    — breaks concretos (CRUD)
 *   /shift-assignment-breaks/:id               — single break ops (PATCH/DELETE)
 *   /shift-templates/:templateId/breaks        — defaults del template (CRUD)
 *   /shift-template-breaks/:id                 — single template-break ops
 *
 * Todos los writes requieren `schedule:write` (consistente con el resto
 * de los endpoints de scheduling).
 */
@Controller()
export class ShiftBreaksController {
  constructor(
    private readonly breakManager: ShiftBreakManager,
    @Inject(SHIFT_ASSIGNMENT_BREAK_REPOSITORY)
    private readonly assignmentBreakRepo: IShiftAssignmentBreakRepository,
    @Inject(SHIFT_TEMPLATE_BREAK_REPOSITORY)
    private readonly templateBreakRepo: IShiftTemplateBreakRepository,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  /** Snapshot serializable de un assignment break. */
  private auditSnapshotBreak(b: ShiftAssignmentBreak): Record<string, unknown> {
    return {
      assignmentId: b.assignmentId,
      startTime: b.startTime.toISOString(),
      endTime: b.endTime.toISOString(),
      isPaid: b.isPaid,
      reason: b.reason,
    };
  }

  // ─── Assignment-level breaks ───────────────────────────────────────

  @Get('shift-assignments/:assignmentId/breaks')
  async listAssignmentBreaks(
    @Param('assignmentId') assignmentId: string,
    @CurrentCompany() companyId: string,
  ): Promise<AssignmentBreakResponse[]> {
    const breaks = await this.assignmentBreakRepo.findByAssignmentId(
      assignmentId,
      companyId,
    );
    return breaks.map(toAssignmentBreakDto);
  }

  @Post('shift-assignments/:assignmentId/breaks')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async createAssignmentBreak(
    @Param('assignmentId') assignmentId: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateAssignmentBreakDto,
  ): Promise<AssignmentBreakResponse> {
    try {
      const created = await this.breakManager.addBreak({
        assignmentId,
        companyId,
        startTime: new Date(dto.startTime),
        endTime: new Date(dto.endTime),
        isPaid: dto.isPaid,
        reason: dto.reason ?? null,
      });
      await this.audit.log({
        companyId,
        entityType: 'shift_assignment_break',
        entityId: created.id,
        action: 'create',
        changes: snapshotAsChangeSet(
          this.auditSnapshotBreak(created),
          'create',
        ),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
      return toAssignmentBreakDto(created);
    } catch (err) {
      throw handleBreakConflict(err);
    }
  }

  @Patch('shift-assignment-breaks/:id')
  @Requires('schedule:write')
  async updateAssignmentBreak(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: UpdateAssignmentBreakDto,
  ): Promise<AssignmentBreakResponse> {
    const before = await this.assignmentBreakRepo.findById(id, companyId);
    try {
      const updated = await this.breakManager.updateBreak({
        breakId: id,
        companyId,
        startTime: dto.startTime ? new Date(dto.startTime) : undefined,
        endTime: dto.endTime ? new Date(dto.endTime) : undefined,
        isPaid: dto.isPaid,
        reason: dto.reason,
      });
      if (before) {
        const changes = computeChangeSet(
          this.auditSnapshotBreak(before),
          this.auditSnapshotBreak(updated),
          ['startTime', 'endTime', 'isPaid', 'reason'],
        );
        if (Object.keys(changes).length > 0) {
          await this.audit.log({
            companyId,
            entityType: 'shift_assignment_break',
            entityId: id,
            action: 'update',
            changes,
            actorUserId: user?.userId ?? null,
            actorEmployeeId: user?.employeeId ?? null,
          });
        }
      }
      return toAssignmentBreakDto(updated);
    } catch (err) {
      throw handleBreakConflict(err);
    }
  }

  @Delete('shift-assignment-breaks/:id')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAssignmentBreak(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const before = await this.assignmentBreakRepo.findById(id, companyId);
    try {
      await this.breakManager.deleteBreak(id, companyId);
      if (before) {
        await this.audit.log({
          companyId,
          entityType: 'shift_assignment_break',
          entityId: id,
          action: 'delete',
          changes: snapshotAsChangeSet(
            this.auditSnapshotBreak(before),
            'delete',
          ),
          actorUserId: user?.userId ?? null,
          actorEmployeeId: user?.employeeId ?? null,
        });
      }
    } catch (err) {
      throw handleBreakConflict(err);
    }
  }

  // ─── Template-level break defaults ─────────────────────────────────

  @Get('shift-templates/:templateId/breaks')
  async listTemplateBreaks(
    @Param('templateId') templateId: string,
    @CurrentCompany() companyId: string,
  ): Promise<TemplateBreakResponse[]> {
    const breaks = await this.templateBreakRepo.findByTemplateId(
      templateId,
      companyId,
    );
    return breaks.map(toTemplateBreakDto);
  }

  @Post('shift-templates/:templateId/breaks')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async createTemplateBreak(
    @Param('templateId') templateId: string,
    @CurrentCompany() companyId: string,
    @Body() dto: CreateTemplateBreakDto,
  ): Promise<TemplateBreakResponse> {
    if (!templateId) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }
    const brk = ShiftTemplateBreak.create({
      id: randomUUID(),
      templateId,
      companyId,
      startOffsetMinutes: dto.startOffsetMinutes,
      durationMinutes: dto.durationMinutes,
      isPaid: dto.isPaid,
      reason: dto.reason ?? null,
    });
    await this.templateBreakRepo.save(brk);
    return toTemplateBreakDto(brk);
  }

  @Delete('shift-template-breaks/:id')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTemplateBreak(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const existing = await this.templateBreakRepo.findById(id, companyId);
    if (!existing) {
      throw new NotFoundException(`TemplateBreak ${id} not found`);
    }
    await this.templateBreakRepo.deleteById(id, companyId);
  }
}
