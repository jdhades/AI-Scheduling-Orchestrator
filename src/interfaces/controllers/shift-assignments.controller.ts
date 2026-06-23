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
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
  IsISO8601,
} from 'class-validator';
import {
  ShiftAssignmentMoverService,
  MoveAssignmentConflictError,
} from '../../domain/services/shift-assignment-mover.service';
import {
  ShiftAssignmentCreatorService,
  CreateAssignmentConflictError,
} from '../../domain/services/shift-assignment-creator.service';
import { FairnessHistoryRecomputerService } from '../../domain/services/fairness-history-recomputer.service';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../domain/repositories/shift-assignment.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { PushService } from '../../infrastructure/notifications/push.service';

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

  /** Nueva localidad (feature Locations). Mandá null para quitarla. */
  @IsOptional()
  @IsString()
  locationId?: string | null;
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

  @IsOptional()
  @IsString()
  locationId?: string | null;
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
    private readonly fairnessRecomputer: FairnessHistoryRecomputerService,
    private readonly companyPreferences: CompanyPreferencesService,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly repo: IShiftAssignmentRepository,
    private readonly notificationsGateway: NotificationsGateway,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly push: PushService,
  ) {}

  /** Best-effort recompute de fairness_history tras mutar una assignment.
   * Errores se loguean y se silencian — el manager no debe ver un 500
   * si el snapshot de KPIs falla. La próxima regeneración del horario
   * sobrescribe igualmente toda la semana. */
  private async refreshFairnessSnapshot(
    companyId: string,
    employeeId: string,
    assignmentDateIso: string,
  ): Promise<void> {
    try {
      const weekStartsOn =
        await this.companyPreferences.getWeekStartsOn(companyId);
      const weekStart =
        FairnessHistoryRecomputerService.weekStartFromAssignmentDate(
          assignmentDateIso,
          weekStartsOn,
        );
      await this.fairnessRecomputer.recomputeForEmployeeWeek(
        companyId,
        employeeId,
        weekStart,
      );
    } catch (err) {
      // No relanzamos — el endpoint principal ya terminó con éxito.

      console.warn(
        `[shift-assignments] fairness recompute failed for emp=${employeeId} date=${assignmentDateIso}:`,
        err,
      );
    }
  }

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
        locationId: dto.locationId ?? null,
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
      await this.refreshFairnessSnapshot(
        companyId,
        assignment.employeeId,
        assignment.date,
      );
      // Avisar por push al empleado del turno nuevo (manual o clonado).
      // Best-effort; no afecta la respuesta.
      void this.push.sendLocalizedToEmployees(
        companyId,
        [assignment.employeeId],
        {
          titleKey: 'push.assignment.created.title',
          bodyKey: 'push.assignment.created.body',
          args: { date: assignment.date },
          data: { type: 'schedule' },
        },
      );
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
    await this.refreshFairnessSnapshot(
      companyId,
      existing.employeeId,
      existing.date,
    );
    this.notificationsGateway.notifyAssignmentChanged(companyId);
    // Avisar al empleado que su turno se canceló (best-effort).
    void this.push.sendLocalizedToEmployees(companyId, [existing.employeeId], {
      titleKey: 'push.assignment.cancelled.title',
      bodyKey: 'push.assignment.cancelled.body',
      args: { date: existing.date },
      data: { type: 'schedule' },
    });
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
      !dto.actualEndTime &&
      dto.locationId === undefined
    ) {
      throw new ConflictException({
        error: 'invalid_request',
        message:
          'At least one of `employeeId`, `date`, `actualStartTime`, `actualEndTime`, `locationId` must be provided.',
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
        newLocationId: dto.locationId,
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
      // Refresh fairness snapshot — la posición previa (si cambió el
      // empleado o la semana) Y la nueva. Si el move se quedó en el
      // mismo (employee, weekStart), una sola pasada alcanza.
      await this.refreshFairnessSnapshot(
        companyId,
        result.assignment.employeeId,
        result.assignment.date,
      );
      if (
        previous &&
        (previous.employeeId !== result.assignment.employeeId ||
          previous.date !== result.assignment.date)
      ) {
        await this.refreshFairnessSnapshot(
          companyId,
          previous.employeeId,
          previous.date,
        );
      }
      // Push al empleado del turno movido (best-effort). Si cambió de empleado,
      // avisar también al anterior que ya no lo tiene.
      const moved = result.assignment;
      void this.push.sendLocalizedToEmployees(companyId, [moved.employeeId], {
        titleKey: 'push.assignment.updated.title',
        bodyKey: 'push.assignment.updated.body',
        args: { date: moved.date },
        data: { type: 'schedule' },
      });
      if (previous && previous.employeeId !== moved.employeeId) {
        void this.push.sendLocalizedToEmployees(
          companyId,
          [previous.employeeId],
          {
            titleKey: 'push.assignment.reassigned.title',
            bodyKey: 'push.assignment.reassigned.body',
            args: { date: previous.date },
            data: { type: 'schedule' },
          },
        );
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
      locationId: a.locationId,
    };
  }

  /**
   * POST /shift-assignments/:id/confirm
   *
   * Empleado marca "leí mi turno". Solo el dueño del assignment puede
   * confirmarse. Idempotente: si ya fue confirmado, devuelve OK sin
   * actualizar el timestamp.
   *
   * NO requiere @Requires('schedule:write') porque es self-action del
   * empleado sobre su propia row — el guard es employeeId match.
   */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirm(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    if (!user?.employeeId) {
      throw new ForbiddenException(
        'Only employees can confirm their own shifts',
      );
    }
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .select('id, employee_id, confirmed_at')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException(`Assignment ${id} not found`);
    if (data.employee_id !== user.employeeId) {
      throw new ForbiddenException('Cannot confirm another employee shift');
    }
    if (data.confirmed_at) return; // Idempotente.
    const { error: updErr } = await this.supabase
      .from('shift_assignments')
      .update({ confirmed_at: new Date().toISOString() })
      .eq('id', id);
    if (updErr) throw new BadRequestException(updErr.message);
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
