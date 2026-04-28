import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { TakeOpenShiftCommand } from '../commands/take-open-shift.command';
import { OpenShiftClaimedEvent } from '../../domain/events/open-shift-claimed.event';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { randomUUID } from 'crypto';

@CommandHandler(TakeOpenShiftCommand)
export class TakeOpenShiftHandler implements ICommandHandler<TakeOpenShiftCommand> {
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: TakeOpenShiftCommand): Promise<void> {
    const { requesterId, currentAssignmentId, targetSlotKey, companyId } = command;

    const requesterAssignment = await this.assignmentRepo.findById(
      currentAssignmentId,
      companyId,
    );
    if (!requesterAssignment || requesterAssignment.employeeId !== requesterId) {
      throw new Error(
        `Assignment ${currentAssignmentId} is not assigned to the requesting employee`,
      );
    }

    // El slot destino se expresa como "templateId|YYYY-MM-DD" (virtual, no persistido).
    const [targetTemplateId, targetDate] = targetSlotKey.split('|');
    if (!targetTemplateId || !targetDate) {
      throw new Error(
        `TakeOpenShiftHandler: invalid slot key "${targetSlotKey}". Expected "templateId|YYYY-MM-DD".`,
      );
    }

    const template = await this.templateRepo.findById(targetTemplateId, companyId);
    if (!template) {
      throw new Error(`Template ${targetTemplateId} not found for company ${companyId}`);
    }

    // "Abierto" = capacidad del slot aún no alcanzada. Si requiredEmployees es
    // null (opcional) cualquier toma libre cuenta; si es un número, respetar cap.
    const existing = await this.assignmentRepo.findBySlot(
      targetTemplateId,
      targetDate,
      companyId,
    );
    const cap = template.requiredEmployees;
    if (cap !== null && cap !== undefined && existing.length >= cap) {
      throw new Error(
        `Slot ${targetSlotKey} is no longer open (${existing.length}/${cap} already filled)`,
      );
    }
    if (existing.some((a) => a.employeeId === requesterId)) {
      throw new Error(`Employee ${requesterId} is already assigned to slot ${targetSlotKey}`);
    }

    await this.assignmentRepo.deleteById(currentAssignmentId, companyId);

    // Materializar horas efectivas desde el template + fecha (el cliente puede
    // editarlas después si lo necesita).
    const [sh, sm] = template.startTime.split(':').map(Number);
    const [eh, em] = template.endTime.split(':').map(Number);
    const actualStart = new Date(`${targetDate}T00:00:00Z`);
    actualStart.setUTCHours(sh, sm, 0, 0);
    let actualEnd = new Date(`${targetDate}T00:00:00Z`);
    actualEnd.setUTCHours(eh, em, 0, 0);
    if (actualEnd <= actualStart) {
      actualEnd = new Date(actualEnd.getTime() + 24 * 60 * 60 * 1000);
    }

    const newAssignment = ShiftAssignment.create({
      id: randomUUID(),
      templateId: targetTemplateId,
      date: targetDate,
      employeeId: requesterId,
      companyId,
      origin: 'exception',
      strategyType: 'hybrid',
      fairnessSnapshot: {},
      actualStartTime: actualStart,
      actualEndTime: actualEnd,
    });
    await this.assignmentRepo.save(newAssignment);

    this.eventBus.publish(
      new OpenShiftClaimedEvent(
        requesterId,
        currentAssignmentId,
        newAssignment.id,
        companyId,
      ),
    );
  }
}
