import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ShiftAssignmentBreak } from '../aggregates/shift-assignment-break.aggregate';
import {
  SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
  type IShiftAssignmentBreakRepository,
} from '../repositories/shift-assignment-break.repository';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../repositories/shift-assignment.repository';
import {
  SHIFT_TEMPLATE_BREAK_REPOSITORY,
  type IShiftTemplateBreakRepository,
} from '../repositories/shift-template-break.repository';

/** Razones por las que un break es rechazado. El controller traduce
 * a 409 + body con el detalle. */
export type BreakConflictReason =
  | 'assignment_not_found'
  | 'out_of_bounds'
  | 'overlap'
  | 'invalid_range'
  | 'break_not_found';

export class BreakConflictError extends Error {
  constructor(
    public readonly reason: BreakConflictReason,
    public readonly detail: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(detail);
    this.name = 'BreakConflictError';
  }
}

interface AddBreakInput {
  assignmentId: string;
  companyId: string;
  startTime: Date;
  endTime: Date;
  isPaid?: boolean;
  reason?: string | null;
}

interface UpdateBreakInput {
  breakId: string;
  companyId: string;
  startTime?: Date;
  endTime?: Date;
  isPaid?: boolean;
  reason?: string | null;
}

/**
 * ShiftBreakManager — domain service que orquesta los aggregates de
 * break con sus invariantes contextuales:
 *
 *   - El break cabe en su assignment (start >= shift.start,
 *     end <= shift.end).
 *   - No overlap con otros breaks del mismo assignment.
 *   - El range es válido (end > start) — esto lo enforce el aggregate
 *     pero lo capturamos para devolver 409 con shape conocido.
 *
 * También expone `materializeTemplateDefaults`: dado un assignment
 * recién creado, lee los `ShiftTemplateBreak` del template y los
 * persiste como `ShiftAssignmentBreak` con tiempos absolutos. Usado
 * por el ShiftAssignmentCreator al crear un assignment desde un
 * template que tiene defaults.
 */
@Injectable()
export class ShiftBreakManager {
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(SHIFT_ASSIGNMENT_BREAK_REPOSITORY)
    private readonly breakRepo: IShiftAssignmentBreakRepository,
    @Inject(SHIFT_TEMPLATE_BREAK_REPOSITORY)
    private readonly templateBreakRepo: IShiftTemplateBreakRepository,
  ) {}

  async addBreak(input: AddBreakInput): Promise<ShiftAssignmentBreak> {
    if (input.endTime.getTime() <= input.startTime.getTime()) {
      throw new BreakConflictError(
        'invalid_range',
        'endTime must be after startTime',
      );
    }
    const assignment = await this.assignmentRepo.findById(
      input.assignmentId,
      input.companyId,
    );
    if (!assignment) {
      throw new BreakConflictError(
        'assignment_not_found',
        `Assignment ${input.assignmentId} not found`,
      );
    }

    const candidate = ShiftAssignmentBreak.create({
      id: randomUUID(),
      assignmentId: input.assignmentId,
      companyId: input.companyId,
      startTime: input.startTime,
      endTime: input.endTime,
      isPaid: input.isPaid,
      reason: input.reason,
    });

    if (
      !candidate.isWithinShift(
        assignment.actualStartTime,
        assignment.actualEndTime,
      )
    ) {
      throw new BreakConflictError(
        'out_of_bounds',
        'Break must be within shift bounds',
        {
          shiftStart: assignment.actualStartTime.toISOString(),
          shiftEnd: assignment.actualEndTime.toISOString(),
        },
      );
    }

    const existing = await this.breakRepo.findByAssignmentId(
      input.assignmentId,
      input.companyId,
    );
    const conflict = existing.find((b) => b.overlapsWith(candidate));
    if (conflict) {
      throw new BreakConflictError(
        'overlap',
        'Break overlaps with an existing break',
        {
          conflictingBreakId: conflict.id,
          conflictingStart: conflict.startTime.toISOString(),
          conflictingEnd: conflict.endTime.toISOString(),
        },
      );
    }

    await this.breakRepo.save(candidate);
    return candidate;
  }

  async updateBreak(input: UpdateBreakInput): Promise<ShiftAssignmentBreak> {
    const current = await this.breakRepo.findById(
      input.breakId,
      input.companyId,
    );
    if (!current) {
      throw new BreakConflictError(
        'break_not_found',
        `Break ${input.breakId} not found`,
      );
    }
    const newStart = input.startTime ?? current.startTime;
    const newEnd = input.endTime ?? current.endTime;
    if (newEnd.getTime() <= newStart.getTime()) {
      throw new BreakConflictError(
        'invalid_range',
        'endTime must be after startTime',
      );
    }
    const assignment = await this.assignmentRepo.findById(
      current.assignmentId,
      input.companyId,
    );
    if (!assignment) {
      // Defensivo — si el assignment se borró con un break huérfano (no
      // debería pasar gracias al CASCADE), lo tratamos como not-found.
      throw new BreakConflictError(
        'assignment_not_found',
        'Parent assignment no longer exists',
      );
    }

    const next = ShiftAssignmentBreak.create({
      id: current.id,
      assignmentId: current.assignmentId,
      companyId: current.companyId,
      startTime: newStart,
      endTime: newEnd,
      isPaid: input.isPaid ?? current.isPaid,
      reason: input.reason !== undefined ? input.reason : current.reason,
      createdAt: current.createdAt,
    });

    if (
      !next.isWithinShift(
        assignment.actualStartTime,
        assignment.actualEndTime,
      )
    ) {
      throw new BreakConflictError(
        'out_of_bounds',
        'Break must be within shift bounds',
      );
    }
    // Overlap check excluyendo el propio break que se está editando.
    const siblings = await this.breakRepo.findByAssignmentId(
      current.assignmentId,
      input.companyId,
    );
    const conflict = siblings
      .filter((b) => b.id !== current.id)
      .find((b) => b.overlapsWith(next));
    if (conflict) {
      throw new BreakConflictError(
        'overlap',
        'Break overlaps with an existing break',
        { conflictingBreakId: conflict.id },
      );
    }

    await this.breakRepo.save(next);
    return next;
  }

  async deleteBreak(breakId: string, companyId: string): Promise<void> {
    const existing = await this.breakRepo.findById(breakId, companyId);
    if (!existing) {
      throw new BreakConflictError(
        'break_not_found',
        `Break ${breakId} not found`,
      );
    }
    await this.breakRepo.deleteById(breakId, companyId);
  }

  /**
   * Materializa los defaults del template como breaks concretos para
   * un assignment recién creado. Best-effort: si algún default no cabe
   * (ej. shift más corto de lo esperado), lo skipea con warning en vez
   * de fallar el create del assignment. Los defaults que sí caben se
   * persisten en un loop — no se aborta el lote si uno falla.
   */
  async materializeTemplateDefaults(params: {
    assignmentId: string;
    templateId: string;
    companyId: string;
    shiftStart: Date;
    shiftEnd: Date;
  }): Promise<void> {
    const defaults = await this.templateBreakRepo.findByTemplateId(
      params.templateId,
      params.companyId,
    );
    if (defaults.length === 0) return;

    for (const def of defaults) {
      const { startTime, endTime } = def.resolveAbsoluteTimes(
        params.shiftStart,
      );
      // Skip silencioso si el default no cabe en este shift puntual —
      // ej. el manager achicó el shift y el break ya no fittea.
      if (
        startTime.getTime() < params.shiftStart.getTime() ||
        endTime.getTime() > params.shiftEnd.getTime()
      ) {
        continue;
      }
      const candidate = ShiftAssignmentBreak.create({
        id: randomUUID(),
        assignmentId: params.assignmentId,
        companyId: params.companyId,
        startTime,
        endTime,
        isPaid: def.isPaid,
        reason: def.reason,
      });
      try {
        await this.breakRepo.save(candidate);
      } catch {
        // Best-effort — un default que falla no debería bloquear la
        // materialización de los siguientes.
      }
    }
  }
}
