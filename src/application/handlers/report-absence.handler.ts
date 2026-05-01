import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { AbsenceReportCreator } from '../../domain/services/absence-report-creator.service';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';

/**
 * ReportAbsenceHandler — adapta el command WhatsApp al AbsenceReportCreator.
 *
 * Phase 17.2 — la lógica de side-effects (borrar assignment, calcular
 * urgencia, publicar event) se movió a AbsenceReportCreator para
 * unificar el flow con el panel manual. Acá solo:
 *   1. Resuelve el assignment puntual al que apunta el command (ya
 *      tiene el assignmentId del WhatsApp parsing).
 *   2. Deriva startDate/endDate desde la fecha del assignment
 *      (single-day por construcción del WhatsApp flow).
 *   3. Delega al creator.
 */
@CommandHandler(ReportAbsenceCommand)
export class ReportAbsenceHandler implements ICommandHandler<ReportAbsenceCommand> {
  private readonly logger = new Logger(ReportAbsenceHandler.name);

  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    private readonly creator: AbsenceReportCreator,
  ) {}

  async execute(command: ReportAbsenceCommand): Promise<void> {
    const { employeeId, assignmentId, reason, companyId } = command;

    const assignment = await this.assignmentRepo.findById(
      assignmentId,
      companyId,
    );
    if (!assignment || assignment.employeeId !== employeeId) {
      throw new Error(
        `Assignment ${assignmentId} is not assigned to employee ${employeeId}`,
      );
    }

    await this.creator.create({
      companyId,
      employeeId,
      reason,
      startDate: assignment.date,
      endDate: assignment.date,
      assignmentIdHint: assignmentId,
    });
  }
}
