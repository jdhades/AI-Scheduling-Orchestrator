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
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsOptional, IsString, IsNotEmpty, Matches, IsISO8601 } from 'class-validator';
import {
  ShiftAssignmentMoverService,
  MoveAssignmentConflictError,
} from '../../domain/services/shift-assignment-mover.service';
import {
  ShiftAssignmentCreatorService,
  CreateAssignmentConflictError,
} from '../../domain/services/shift-assignment-creator.service';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../domain/repositories/shift-assignment.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * MoveAssignmentDto
 *
 * Body del PATCH. Al menos uno de `employeeId` / `date` /
 * `actualStartTime` / `actualEndTime` debe venir; el service rechaza
 * con `no_change` si todos son iguales al estado actual.
 *
 * Resize (Phase 19E.3): el manager puede mandar solo
 * `actualStartTime`/`actualEndTime` para shrink/stretch del turno
 * sin cambiar empleado ni fecha.
 */
export class MoveAssignmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  employeeId?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  /** ISO 8601 datetime UTC. */
  @IsOptional()
  @IsISO8601()
  actualStartTime?: string;

  /** ISO 8601 datetime UTC. */
  @IsOptional()
  @IsISO8601()
  actualEndTime?: string;

  /** Texto libre opcional (audit log). */
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CreateAssignmentDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  templateId!: string;

  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * ShiftAssignmentsController
 *
 * PATCH /shift-assignments/:id?companyId=...
 *   → mueve la assignment a otro empleado/día. Hard rules verifican
 *     no doble-booking y mismatch de departamento. Audit en
 *     `shift_assignment_edits`. WS broadcast `AssignmentMoved`.
 */
@Controller('shift-assignments')
export class ShiftAssignmentsController {
  constructor(
    private readonly mover: ShiftAssignmentMoverService,
    private readonly creator: ShiftAssignmentCreatorService,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly repo: IShiftAssignmentRepository,
    private readonly notificationsGateway: NotificationsGateway,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  /**
   * POST /shift-assignments?companyId=...
   *
   * Crea una assignment manual. Hard rules: empleado existe,
   * template existe, no doble-booking. Marca origin='override'.
   */
  @Post()
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateAssignmentDto,
  ): Promise<{ assignment: object }> {
    try {
      const assignment = await this.creator.create({
        companyId,
        employeeId: dto.employeeId,
        templateId: dto.templateId,
        date: dto.date,
        reason: dto.reason,
      });
      await this.audit.log({
        companyId,
        entityType: 'shift_assignment',
        entityId: assignment.id,
        action: 'create',
        changes: snapshotAsChangeSet(this.auditSnapshot(assignment), 'create'),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
      return { assignment: this.toDto(assignment) };
    } catch (err) {
      if (err instanceof CreateAssignmentConflictError) {
        throw new ConflictException({
          error: err.reason,
          message: err.detail,
          ...(err.meta ?? {}),
        });
      }
      throw err;
    }
  }

  /**
   * DELETE /shift-assignments/:id?companyId=...
   *
   * Borra una assignment. 204 si OK, 404 si no existe. Sin audit
   * profundo en v1 — el WS event AssignmentChanged + el log dejan
   * trace básico.
   */
  @Delete(':id')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const existing = await this.repo.findById(id, companyId);
    if (!existing) {
      throw new NotFoundException(`Assignment ${id} not found`);
    }
    await this.repo.deleteById(id, companyId);
    await this.audit.log({
      companyId,
      entityType: 'shift_assignment',
      entityId: id,
      action: 'delete',
      changes: snapshotAsChangeSet(this.auditSnapshot(existing), 'delete'),
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
    this.notificationsGateway.notifyAssignmentChanged(companyId);
  }

  @Patch(':id')
  @Requires('schedule:write')
  async patch(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: MoveAssignmentDto,
  ): Promise<{ assignment: object; warnings: string[] }> {
    if (
      !dto.employeeId &&
      !dto.date &&
      !dto.actualStartTime &&
      !dto.actualEndTime
    ) {
      throw new ConflictException({
        error: 'invalid_request',
        message:
          'At least one of `employeeId`, `date`, `actualStartTime`, `actualEndTime` must be provided.',
      });
    }
    const previous = await this.repo.findById(id, companyId);
    try {
      const result = await this.mover.move({
        companyId,
        assignmentId: id,
        newEmployeeId: dto.employeeId,
        newDate: dto.date,
        newActualStartTime: dto.actualStartTime
          ? new Date(dto.actualStartTime)
          : undefined,
        newActualEndTime: dto.actualEndTime
          ? new Date(dto.actualEndTime)
          : undefined,
        reason: dto.reason,
        editedByUserId: user?.userId ?? null,
      });
      if (previous) {
        const fields = [
          'employeeId',
          'templateId',
          'date',
          'actualStartTime',
          'actualEndTime',
          'origin',
        ] as const;
        await this.audit.log({
          companyId,
          entityType: 'shift_assignment',
          entityId: id,
          action: 'update',
          changes: computeChangeSet(
            this.auditSnapshot(previous),
            this.auditSnapshot(result.assignment),
            fields,
          ),
          actorUserId: user?.userId ?? null,
          actorEmployeeId: user?.employeeId ?? null,
        });
      }
      return {
        assignment: this.toDto(result.assignment),
        warnings: result.warnings,
      };
    } catch (err) {
      if (err instanceof MoveAssignmentConflictError) {
        if (err.reason === 'assignment_not_found') {
          throw new NotFoundException({
            error: err.reason,
            message: err.detail,
          });
        }
        throw new ConflictException({
          error: err.reason,
          message: err.detail,
          ...(err.meta ?? {}),
        });
      }
      throw err;
    }
  }

  private toDto(a: ShiftAssignment): object {
    return {
      id: a.id,
      templateId: a.templateId,
      date: a.date,
      employeeId: a.employeeId,
      origin: a.origin,
      actualStartTime: a.actualStartTime.toISOString(),
      actualEndTime: a.actualEndTime.toISOString(),
    };
  }

  /** Snapshot serializable usado por el audit log. */
  private auditSnapshot(a: ShiftAssignment): {
    employeeId: string;
    templateId: string;
    date: string;
    actualStartTime: string;
    actualEndTime: string;
    origin: string;
  } {
    return {
      employeeId: a.employeeId,
      templateId: a.templateId,
      date: a.date,
      actualStartTime: a.actualStartTime.toISOString(),
      actualEndTime: a.actualEndTime.toISOString(),
      origin: a.origin,
    };
  }
}
