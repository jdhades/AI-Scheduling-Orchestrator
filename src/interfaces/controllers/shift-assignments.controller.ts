import {
  Body,
  ConflictException,
  Controller,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { IsOptional, IsString, IsNotEmpty, Matches } from 'class-validator';
import {
  ShiftAssignmentMoverService,
  MoveAssignmentConflictError,
} from '../../domain/services/shift-assignment-mover.service';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../domain/repositories/shift-assignment.repository';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * MoveAssignmentDto
 *
 * Body del PATCH. Al menos uno de `employeeId` / `date` debe venir;
 * el service rechaza con `no_change` si ambos son iguales al actual.
 */
export class MoveAssignmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  employeeId?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  /** Texto libre opcional (audit log). */
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
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly repo: IShiftAssignmentRepository,
  ) {}

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() dto: MoveAssignmentDto,
  ): Promise<{ assignment: object; warnings: string[] }> {
    if (!dto.employeeId && !dto.date) {
      throw new ConflictException({
        error: 'invalid_request',
        message:
          'At least one of `employeeId` or `date` must be provided.',
      });
    }
    try {
      const result = await this.mover.move({
        companyId,
        assignmentId: id,
        newEmployeeId: dto.employeeId,
        newDate: dto.date,
        reason: dto.reason,
        // Sin JWT auth todavía. Cuando entre, leer del context.
        editedByUserId: null,
      });
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
}
