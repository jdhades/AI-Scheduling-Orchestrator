import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import { AbsenceReport } from '../aggregates/absence-report.aggregate';
import {
  ABSENCE_REPORT_REPOSITORY,
  type IAbsenceReportRepository,
} from '../repositories/absence-report.repository';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../repositories/shift-assignment.repository';
import {
  EMPLOYEE_REPOSITORY,
  type IEmployeeRepository,
} from '../repositories/employee.repository';
import {
  type IShiftTemplateRepository,
} from '../repositories/shift-template.repository';
import { AbsenceReportedEvent } from '../events/absence-reported.event';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export interface CreateAbsenceReportInput {
  companyId: string;
  employeeId: string;
  reason: string;
  /** YYYY-MM-DD. Si no llega, default = hoy. */
  startDate?: string;
  /** YYYY-MM-DD. Si no llega, default = startDate. */
  endDate?: string;
  /**
   * Hint del WhatsApp flow: cuando el empleado dice "no voy a este turno"
   * sabemos qué assignment es. El creator igual busca todos los
   * assignments dentro del range; el hint solo se persiste como reference.
   */
  assignmentIdHint?: string | null;
}

export interface AbsenceReportCreationResult {
  report: AbsenceReport;
  /** Assignments borrados como side-effect. */
  deletedAssignmentIds: string[];
  /** Si algún assignment del range empieza en < 2h, marca urgente. */
  isUrgent: boolean;
}

/**
 * AbsenceReportCreator — Domain Service
 *
 * Phase 17.2 — unifica el flow de alta de un absence report entre los
 * dos callers (WhatsApp via ReportAbsenceHandler y el panel via
 * AbsenceReportsController). Antes la lógica de borrar assignments y
 * publicar el event vivía solo en el path WhatsApp; el panel solo
 * persistía el row sin efectos.
 *
 * Side-effects unificados:
 *   1. Resolver el rango de fechas (defaults a hoy si no llegan).
 *   2. Encontrar todos los assignments del empleado en ese rango.
 *   3. Borrarlos uno por uno (`deleteByDateRange` no scope-by-employee).
 *   4. Calcular isUrgent (algún assignment inicia en < 2h).
 *   5. Persistir el AbsenceReport con startDate/endDate.
 *   6. Publicar AbsenceReportedEvent (handler manda WhatsApp al manager).
 */
@Injectable()
export class AbsenceReportCreator {
  private readonly logger = new Logger(AbsenceReportCreator.name);

  constructor(
    @Inject(ABSENCE_REPORT_REPOSITORY)
    private readonly absenceRepo: IAbsenceReportRepository,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    private readonly eventBus: EventBus,
  ) {}

  async create(input: CreateAbsenceReportInput): Promise<AbsenceReportCreationResult> {
    const { companyId, employeeId, reason } = input;

    const employee = await this.employeeRepo.findById(employeeId, companyId);
    if (!employee) {
      throw new Error(`Employee ${employeeId} not found in tenant`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const startDate = input.startDate ?? today;
    const endDate = input.endDate ?? startDate;
    if (endDate < startDate) {
      throw new Error(
        `endDate (${endDate}) cannot be before startDate (${startDate})`,
      );
    }

    // 1. Encontrar y borrar assignments del empleado en el range.
    const affected = await this.assignmentRepo.findByEmployeeAndDateRange(
      employeeId,
      companyId,
      startDate,
      endDate,
    );
    const deletedIds: string[] = [];
    for (const a of affected) {
      try {
        await this.assignmentRepo.deleteById(a.id, companyId);
        deletedIds.push(a.id);
      } catch (err) {
        // No abortamos por un assignment, registramos y seguimos.
        this.logger.warn(
          `Failed to delete assignment ${a.id} during absence creation: ${(err as Error).message}`,
        );
      }
    }

    // 2. Calcular isUrgent — algún assignment afectado empieza en < 2h.
    let isUrgent = false;
    for (const a of affected) {
      const template = await this.templateRepo.findById(a.templateId, companyId);
      if (!template) continue;
      const [h, m] = template.startTime.split(':').map((n) => parseInt(n, 10));
      const slotStart = new Date(`${a.date}T00:00:00Z`);
      slotStart.setUTCHours(h, m, 0, 0);
      if (slotStart.getTime() - Date.now() <= TWO_HOURS_MS) {
        isUrgent = true;
        break;
      }
    }

    // 3. Persistir el reporte. assignmentId guarda el hint si llegó —
    // útil para audit retroactivo del WhatsApp flow.
    const report = AbsenceReport.create({
      id: randomUUID(),
      companyId,
      employeeId,
      assignmentId: input.assignmentIdHint ?? null,
      reason,
      startDate,
      endDate,
      isUrgent,
    });
    await this.absenceRepo.save(report);

    // 4. Publicar event (AbsenceReportedHandler manda WhatsApp al manager).
    // Pasamos el primer affectedId (legacy compat). Si no había turnos en
    // el range, mandamos null y el handler igual notifica al manager con
    // el reason y el período.
    this.eventBus.publish(
      new AbsenceReportedEvent(
        employeeId,
        deletedIds[0] ?? '',
        reason,
        companyId,
        isUrgent,
      ),
    );

    return { report, deletedAssignmentIds: deletedIds, isUrgent };
  }
}
