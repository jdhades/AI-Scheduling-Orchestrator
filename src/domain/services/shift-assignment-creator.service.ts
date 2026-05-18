import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../repositories/shift-assignment.repository';
import {
  EMPLOYEE_REPOSITORY,
  type IEmployeeRepository,
} from '../repositories/employee.repository';
import type { IShiftTemplateRepository } from '../repositories/shift-template.repository';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import { ShiftBreakManager } from './shift-break-manager.service';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';

export interface CreateAssignmentInput {
  companyId: string;
  employeeId: string;
  templateId: string;
  date: string; // YYYY-MM-DD
  reason?: string | null;
}

export type CreateConflictReason =
  | 'employee_not_found'
  | 'template_not_found'
  | 'employee_already_has_shift';

export class CreateAssignmentConflictError extends Error {
  constructor(
    public readonly reason: CreateConflictReason,
    public readonly detail: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(detail);
    this.name = 'CreateAssignmentConflictError';
  }
}

/**
 * ShiftAssignmentCreatorService
 *
 * Crea una assignment "manual" desde el panel — ej. el manager
 * cubre un turno que el LLM no asignó. Reglas hard idénticas al
 * Mover: empleado existe, template existe, no doble-booking.
 *
 * Origen marcado como `override` para distinguirlo del flujo
 * `membership` (auto-asignado por el scheduler).
 */
@Injectable()
export class ShiftAssignmentCreatorService {
  private readonly logger = new Logger(ShiftAssignmentCreatorService.name);

  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly breakManager: ShiftBreakManager,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  async create(input: CreateAssignmentInput): Promise<ShiftAssignment> {
    const employee = await this.employeeRepo.findById(
      input.employeeId,
      input.companyId,
    );
    if (!employee) {
      throw new CreateAssignmentConflictError(
        'employee_not_found',
        `Employee ${input.employeeId} not found`,
      );
    }

    const template = await this.templateRepo.findById(
      input.templateId,
      input.companyId,
    );
    if (!template) {
      throw new CreateAssignmentConflictError(
        'template_not_found',
        `Template ${input.templateId} not found`,
      );
    }

    // Hard rule: no doble-booking del empleado el mismo día.
    const sameDay = await this.assignmentRepo.findByEmployeeAndDateRange(
      input.employeeId,
      input.companyId,
      input.date,
      input.date,
    );
    if (sameDay.length > 0) {
      throw new CreateAssignmentConflictError(
        'employee_already_has_shift',
        `Employee ${employee.name} already has a shift on ${input.date}`,
        { conflictingAssignmentId: sameDay[0].id },
      );
    }

    // actualStartTime/EndTime: combinar date + template.HH:MM. Si el
    // template cruza medianoche (endTime <= startTime), endTime cae al
    // día siguiente.
    const start = this.combine(input.date, template.startTime);
    let end = this.combine(input.date, template.endTime);
    if (end.getTime() <= start.getTime()) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }

    const assignment = ShiftAssignment.create({
      id: randomUUID(),
      templateId: input.templateId,
      date: input.date,
      employeeId: input.employeeId,
      companyId: input.companyId,
      origin: 'override',
      strategyType: 'hybrid',
      fairnessSnapshot: {},
      actualStartTime: start,
      actualEndTime: end,
    });

    await this.assignmentRepo.save(assignment);
    // Materializa los breaks default del template (si los hay) como
    // breaks concretos del nuevo assignment. Best-effort — los que no
    // fittean por shift más corto de lo esperado se skipean.
    await this.breakManager.materializeTemplateDefaults({
      assignmentId: assignment.id,
      templateId: input.templateId,
      companyId: input.companyId,
      shiftStart: start,
      shiftEnd: end,
    });
    this.notificationsGateway.notifyAssignmentChanged(input.companyId);

    this.logger.log(
      `Created assignment ${assignment.id} ` +
        `(employee=${input.employeeId} template=${input.templateId} date=${input.date}) ` +
        `reason="${input.reason ?? ''}"`,
    );
    return assignment;
  }

  /** Combina YYYY-MM-DD + HH:MM en una Date UTC (convención del backend). */
  private combine(dateISO: string, hhmm: string): Date {
    const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
    const d = new Date(`${dateISO}T00:00:00.000Z`);
    d.setUTCHours(h, m, 0, 0);
    return d;
  }
}
