import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { AbsenceReportedEvent } from '../../domain/events/absence-reported.event';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import { ManagerNotificationService } from '../services/manager-notification.service';

/**
 * AbsenceReportedHandler
 *
 * Notifica al manager cuando se reporta una ausencia. Phase 17.5 — el
 * mensaje muestra nombre del empleado y nombre/horario del/los turno(s)
 * afectado(s) en vez de UUIDs / phone. Soporta single-day y multi-day.
 *
 * Si `isUrgent`, escala con 🚨.
 */
@EventsHandler(AbsenceReportedEvent)
export class AbsenceReportedHandler implements IEventHandler<AbsenceReportedEvent> {
  private readonly logger = new Logger(AbsenceReportedHandler.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly managerNotifications: ManagerNotificationService,
  ) {}

  async handle(event: AbsenceReportedEvent): Promise<void> {
    const {
      employeeId,
      reason,
      companyId,
      isUrgent,
      startDate,
      endDate,
      deletedAssignmentIds,
    } = event;

    try {
      const employee = await this.employeeRepo.findById(employeeId, companyId);
      if (!employee) return;

      const urgencyPrefix = isUrgent
        ? '🚨 *ALERTA URGENTE* — Turno en menos de 2 horas\n'
        : '⚠️ *Ausencia reportada*\n';

      const periodLine = this.formatPeriod(startDate, endDate);
      const shiftsBlock = await this.formatAffectedShifts(
        deletedAssignmentIds,
        companyId,
      );

      const lines = [
        `${urgencyPrefix}`,
        `*Empleado:* ${employee.name}${
          employee.phone ? ` (${employee.phone})` : ''
        }`,
        periodLine ? `*Período:* ${periodLine}` : '',
        shiftsBlock,
        `*Motivo:* ${reason}`,
        '',
        deletedAssignmentIds.length === 0
          ? 'No había turnos asignados en ese período. El scheduler lo respetará al generar.'
          : isUrgent
            ? '🔴 Se necesita reemplazo urgente.'
            : 'Se necesita reasignar el/los turno(s).',
      ].filter((l) => l.length > 0);

      const message = lines.join('\n');

      await this.managerNotifications.notifyManagerForEmployee(
        companyId,
        employeeId,
        message,
      );
    } catch (err) {
      this.logger.error(
        `AbsenceReportedHandler failed: ${(err as Error).message}`,
      );
    }
  }

  private formatPeriod(startDate: string, endDate: string): string {
    if (!startDate) return '';
    if (!endDate || startDate === endDate) return startDate;
    return `${startDate} → ${endDate}`;
  }

  /**
   * Resuelve cada assignmentId → "TemplateName · YYYY-MM-DD HH:MM–HH:MM"
   * para mostrarle al manager qué turnos hay que cubrir. Si la lista es
   * vacía (alta manual sin assignments en el range) devuelve cadena
   * vacía y el caller la omite.
   */
  private async formatAffectedShifts(
    assignmentIds: string[],
    companyId: string,
  ): Promise<string> {
    if (assignmentIds.length === 0) return '';

    const lines: string[] = [];
    for (const id of assignmentIds) {
      const assignment = await this.assignmentRepo.findById(id, companyId);
      if (!assignment) continue;
      const template = await this.templateRepo.findById(
        assignment.templateId,
        companyId,
      );
      const name = template?.name ?? `template ${assignment.templateId.slice(0, 8)}`;
      const start = template ? this.shortTime(template.startTime) : '';
      const end = template ? this.shortTime(template.endTime) : '';
      const timeRange = start && end ? ` ${start}–${end}` : '';
      lines.push(`  • ${name} · ${assignment.date}${timeRange}`);
    }

    if (lines.length === 0) return '';
    const header =
      lines.length === 1
        ? '*Turno afectado:*'
        : `*Turnos afectados (${lines.length}):*`;
    return `${header}\n${lines.join('\n')}`;
  }

  /** "08:00:00" → "08:00", "08:00" pasa tal cual. */
  private shortTime(t: string): string {
    return t.length >= 5 ? t.slice(0, 5) : t;
  }
}
