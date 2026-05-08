import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../repositories/shift-assignment.repository';
import {
  EMPLOYEE_REPOSITORY,
  type IEmployeeRepository,
} from '../repositories/employee.repository';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';

export interface MoveAssignmentInput {
  companyId: string;
  assignmentId: string;
  /** Nuevo employeeId. Si es igual al actual, no cambia. */
  newEmployeeId?: string;
  /** Nuevo date YYYY-MM-DD. Si es igual al actual, no cambia. */
  newDate?: string;
  /** Audit metadata. */
  editedByUserId?: string | null;
  reason?: string | null;
}

export type MoveConflictReason =
  | 'employee_already_has_shift'
  | 'department_mismatch'
  | 'employee_not_found'
  | 'assignment_not_found'
  | 'no_change';

export class MoveAssignmentConflictError extends Error {
  constructor(
    public readonly reason: MoveConflictReason,
    public readonly detail: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(detail);
    this.name = 'MoveAssignmentConflictError';
  }
}

export interface MoveAssignmentResult {
  assignment: ShiftAssignment;
  /** Soft warnings — no bloquean el move pero el manager debería verlas. */
  warnings: string[];
}

/**
 * ShiftAssignmentMoverService
 *
 * Encapsula la lógica de "mover" una assignment manualmente — el path
 * que se dispara desde drag & drop del panel. Validaciones HARD
 * (rechazan): doble booking del empleado, mismatch de departamento.
 * Validaciones SOFT (warnings): pendientes (working time, skill
 * required) — para no bloquear el flujo del manager mientras se
 * itera sobre policies.
 *
 * Side effects:
 *   - Persiste assignment con nueva tupla (employee_id, date)
 *   - Inserta row en shift_assignment_edits (audit)
 *   - Emite WS event AssignmentMoved
 *
 * NO regenera fairness ni recalcula nada del scheduler — un move es
 * una intervención manual y la fairness se recomputa cuando se
 * regenera la semana.
 */
@Injectable()
export class ShiftAssignmentMoverService {
  private readonly logger = new Logger(ShiftAssignmentMoverService.name);

  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  async move(input: MoveAssignmentInput): Promise<MoveAssignmentResult> {
    const current = await this.assignmentRepo.findById(
      input.assignmentId,
      input.companyId,
    );
    if (!current) {
      throw new MoveAssignmentConflictError(
        'assignment_not_found',
        `Assignment ${input.assignmentId} not found`,
      );
    }

    const newEmployeeId = input.newEmployeeId ?? current.employeeId;
    const newDate = input.newDate ?? current.date;
    if (
      newEmployeeId === current.employeeId &&
      newDate === current.date
    ) {
      throw new MoveAssignmentConflictError(
        'no_change',
        'Move requested but employee and date are unchanged',
      );
    }

    const newEmployee = await this.employeeRepo.findById(
      newEmployeeId,
      input.companyId,
    );
    if (!newEmployee) {
      throw new MoveAssignmentConflictError(
        'employee_not_found',
        `Employee ${newEmployeeId} not found`,
      );
    }

    // Hard rule: el target no puede tener ya otro shift ese día. Si lo
    // tiene, el manager debe primero borrarlo o swappear (feature
    // futuro). Excluimos la propia assignment del check (caso: solo
    // cambia de date para el mismo empleado).
    const sameDay = await this.assignmentRepo.findByEmployeeAndDateRange(
      newEmployeeId,
      input.companyId,
      newDate,
      newDate,
    );
    const conflict = sameDay.find((a) => a.id !== current.id);
    if (conflict) {
      throw new MoveAssignmentConflictError(
        'employee_already_has_shift',
        `Employee ${newEmployee.name} already has a shift on ${newDate}`,
        { conflictingAssignmentId: conflict.id },
      );
    }

    // Soft warnings (TODO: enriquecer cuando entren policies del
    // PolicyEnforcementService — minRestHoursBetweenShifts, skill
    // requerido, max horas semanales, etc).
    const warnings: string[] = [];

    // Re-construir la fecha actualStartTime/EndTime si cambia el date.
    // El template define la hora-de-pared; armamos la nueva Date
    // preservando esa hora pero en el nuevo día.
    const { actualStartTime: newStart, actualEndTime: newEnd } =
      this.shiftTimesForNewDate(
        current.actualStartTime,
        current.actualEndTime,
        current.date,
        newDate,
      );

    const updated = ShiftAssignment.fromPersistence({
      id: current.id,
      templateId: current.templateId,
      date: newDate,
      employeeId: newEmployeeId,
      companyId: current.companyId,
      origin: 'override', // un move manual deja la marca de override
      assignedAt: current.assignedAt,
      assignedByStrategy: current.assignedByStrategy,
      fairnessSnapshot: current.fairnessSnapshot,
      actualStartTime: newStart,
      actualEndTime: newEnd,
    });

    await this.assignmentRepo.save(updated);

    // Audit row — fire-and-forget al log si falla, no bloquea el move
    // (el move ya está persistido). En el futuro, transacción atómica.
    const { error: auditError } = await this.supabase
      .from('shift_assignment_edits')
      .insert({
        company_id: input.companyId,
        assignment_id: current.id,
        edited_by_user_id: input.editedByUserId ?? null,
        old_employee_id: current.employeeId,
        new_employee_id: newEmployeeId,
        old_date: current.date,
        new_date: newDate,
        reason: input.reason ?? null,
      });
    if (auditError) {
      this.logger.warn(
        `Audit insert failed for move of ${current.id}: ${auditError.message}`,
      );
    }

    // WS broadcast — el dashboard refresca el horario (los managers
    // viendo otro browser ven el cambio sin recargar).
    this.notificationsGateway.notifyAssignmentMoved(
      input.companyId,
      updated.id,
    );

    this.logger.log(
      `Moved assignment ${current.id} ` +
        `(employee ${current.employeeId}→${newEmployeeId}, date ${current.date}→${newDate})`,
    );

    return { assignment: updated, warnings };
  }

  /**
   * Reconstruye `actualStartTime`/`actualEndTime` cuando cambia el
   * date. Preserva la hora-de-pared (componente UTC, según convención
   * del backend) y solo desplaza al nuevo día. Si el shift cruzaba
   * medianoche (endTime al día siguiente), preserva ese desplazamiento.
   */
  private shiftTimesForNewDate(
    oldStart: Date,
    oldEnd: Date,
    oldDateISO: string,
    newDateISO: string,
  ): { actualStartTime: Date; actualEndTime: Date } {
    const dayDeltaMs =
      Date.parse(`${newDateISO}T00:00:00.000Z`) -
      Date.parse(`${oldDateISO}T00:00:00.000Z`);
    return {
      actualStartTime: new Date(oldStart.getTime() + dayDeltaMs),
      actualEndTime: new Date(oldEnd.getTime() + dayDeltaMs),
    };
  }
}
