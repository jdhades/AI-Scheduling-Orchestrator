import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus, EventBus } from '@nestjs/cqrs';
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
import { type IShiftTemplateRepository } from '../repositories/shift-template.repository';
import { AbsenceReportedEvent } from '../events/absence-reported.event';
import { CreateSemanticRuleCommand } from '../../application/commands/create-semantic-rule.command';

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
  /**
   * UUID del employee que origina la solicitud (manager o self). Se
   * usa como `created_by` de la semantic rule (FK a employees). Null o
   * undefined = system-generated.
   */
  createdByUserId?: string | null;
}

export interface AbsenceReportCreationResult {
  /**
   * absence_report persistido — siempre se crea (Phase 18.5). Cubre el
   * rango completo declarado por el caller, sin importar si hubo
   * deletes o si todo es futuro. Sirve como histórico/tracking en el
   * panel /approvals/absences.
   */
  report: AbsenceReport;
  /** Assignments borrados como side-effect. */
  deletedAssignmentIds: string[];
  /** Si algún assignment del range empieza en < 2h, marca urgente. */
  isUrgent: boolean;
  /**
   * Phase 18.2 — semantic rules creadas para cubrir días sin assignments
   * existentes. Cada rango contiguo de días sin turnos genera una rule.
   */
  rulesCreated: Array<{ startDate: string; endDate: string; ruleText: string }>;
}

/**
 * Resultado de aplicar el side-effect "el empleado X no está disponible
 * en este rango". Reutilizable por absence_report (Phase 18.2) y day-off
 * approve (Phase 18.3) — ambos comparten la misma semántica.
 */
export interface UnavailabilitySideEffectResult {
  /** Refs de assignments borrados (con templateId/date para descripción). */
  deleted: Array<{ id: string; templateId: string; date: string }>;
  /** Rangos contiguos de días sin assignments → rules creadas. */
  rulesCreated: Array<{ startDate: string; endDate: string; ruleText: string }>;
  /** Algún assignment afectado inicia en < 2h. */
  isUrgent: boolean;
}

/**
 * AbsenceReportCreator — Domain Service
 *
 * Phase 18.2 — modelo "antes / después" separado:
 *
 *   - Días con assignments existentes → caso "histórico/consumado" → se
 *     borran los assignments y queda registro en absence_reports.
 *   - Días sin assignments (rango futuro sin generar) → caso "regla
 *     antes de generar" → se crea una semantic rule para que el
 *     scheduler la respete cuando se genere la semana.
 *   - Mixto → ambas cosas.
 *
 * Side-effects unificados:
 *   1. Resolver el rango (defaults a hoy si no llegan).
 *   2. Day-by-day: buscar assignment → borrar (sigue acumulando) o
 *      marcarlo como "rule-day".
 *   3. Calcular isUrgent (algún assignment inicia en < 2h).
 *   4. Si hubo deletes → persistir absence_report + publicar event
 *      (handler manda WhatsApp al manager).
 *   5. Para los rule-days, agrupar contiguous y crear semantic rules
 *      vía CommandBus (reusa embedding + dedup pipeline).
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
    private readonly commandBus: CommandBus,
  ) {}

  async create(
    input: CreateAbsenceReportInput,
  ): Promise<AbsenceReportCreationResult> {
    const { companyId, employeeId, reason } = input;

    const employee = await this.employeeRepo.findById(employeeId, companyId);
    if (!employee) {
      throw new Error(`Employee ${employeeId} not found in tenant`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const startDate = input.startDate ?? today;
    const endDate = input.endDate ?? startDate;

    const sideEffects = await this.applyUnavailability({
      companyId,
      employeeId,
      employeeName: employee.name,
      startDate,
      endDate,
      reason,
      createdByUserId: input.createdByUserId,
      ruleSource: 'absence',
    });

    // Persist absence_report SIEMPRE: el rango completo declarado por
    // el caller queda como histórico para tracking, sin importar si
    // tuvo efectos operacionales (deletes) o solo se materializó como
    // semantic rule(s) para el scheduler. El manager ve TODAS las
    // ausencias reportadas en el listado /approvals/absences.
    const deletedIds = sideEffects.deleted.map((d) => d.id);
    const report = AbsenceReport.create({
      id: randomUUID(),
      companyId,
      employeeId,
      assignmentId: input.assignmentIdHint ?? deletedIds[0] ?? null,
      reason,
      startDate,
      endDate,
      isUrgent: sideEffects.isUrgent,
    });
    await this.absenceRepo.save(report);

    // Notificación al manager: solo cuando hubo efecto operacional
    // (deletes) o cuando es urgente. Las ausencias 100% futuras sin
    // turnos asignados no requieren acción inmediata — el scheduler
    // las respetará al generar y queda registrada en el panel.
    if (deletedIds.length > 0 || sideEffects.isUrgent) {
      this.eventBus.publish(
        new AbsenceReportedEvent(
          employeeId,
          deletedIds[0] ?? '',
          reason,
          companyId,
          sideEffects.isUrgent,
          startDate,
          endDate,
          deletedIds,
        ),
      );
    }

    return {
      report,
      deletedAssignmentIds: deletedIds,
      isUrgent: sideEffects.isUrgent,
      rulesCreated: sideEffects.rulesCreated,
    };
  }

  /**
   * Aplica el side-effect "el empleado X no está disponible del start al
   * end" — sin persistir absence_report ni publicar event. Reutilizable
   * por DayOff approve (Phase 18.3) o cualquier otro flow que necesite
   * la misma semántica.
   *
   *  - Días con assignments → borra los assignments (acumula refs).
   *  - Días sin assignments → agrupa en rangos contiguos y crea una
   *    semantic rule por cada rango (priority Hard, restriction,
   *    expiresAt = endDate del rango).
   *  - Calcula isUrgent (algún assignment empieza < 2h).
   *
   * `createdByUserId` debe ser UUID de employee (FK semantic_rules.created_by)
   * o null para system-generated. Strings formateados rompen la FK.
   */
  async applyUnavailability(input: {
    companyId: string;
    employeeId: string;
    employeeName: string;
    startDate: string;
    endDate: string;
    reason: string;
    /** UUID del actor (manager o self). Null = system-generated. */
    createdByUserId?: string | null;
    /** Tag para metadata.source de la rule — facilita auditoría. */
    ruleSource: 'absence' | 'day-off';
  }): Promise<UnavailabilitySideEffectResult> {
    const {
      companyId,
      employeeId,
      employeeName,
      startDate,
      endDate,
      reason,
      ruleSource,
    } = input;

    if (endDate < startDate) {
      throw new Error(
        `endDate (${endDate}) cannot be before startDate (${startDate})`,
      );
    }

    // 1. Day-by-day classification.
    const allDays = this.expandDays(startDate, endDate);
    const dayClassification: Array<{ date: string; assignmentIds: string[] }> =
      [];
    for (const date of allDays) {
      const assignments = await this.assignmentRepo.findByEmployeeAndDateRange(
        employeeId,
        companyId,
        date,
        date,
      );
      dayClassification.push({
        date,
        assignmentIds: assignments.map((a) => a.id),
      });
    }

    const daysWithAssignments = dayClassification.filter(
      (d) => d.assignmentIds.length > 0,
    );
    const daysWithoutAssignments = dayClassification.filter(
      (d) => d.assignmentIds.length === 0,
    );

    // 2. Borrar atómicamente todos los assignments del rango con una
    //    sola SQL statement. Postgres garantiza all-or-nothing — si una
    //    fila falla el constraint, ninguna se borra. Eso evita el
    //    estado mixto del loop anterior (algunos deletes confirmados +
    //    el resto huérfanos sin rule cubriendo) cuando el handler crashea
    //    a mitad. Single round-trip vs N+N round-trips también.
    const idsToDelete = daysWithAssignments.flatMap((d) => d.assignmentIds);
    const deleted =
      idsToDelete.length > 0
        ? await this.assignmentRepo.deleteByIdsBatch(idsToDelete, companyId)
        : [];

    // 3. isUrgent — algún assignment afectado empieza < 2h.
    let isUrgent = false;
    for (const ref of deleted) {
      if (!ref.templateId) continue;
      const template = await this.templateRepo.findById(
        ref.templateId,
        companyId,
      );
      if (!template) continue;
      const [h, m] = template.startTime.split(':').map((n) => parseInt(n, 10));
      const slotStart = new Date(`${ref.date}T00:00:00Z`);
      slotStart.setUTCHours(h, m, 0, 0);
      if (slotStart.getTime() - Date.now() <= TWO_HOURS_MS) {
        isUrgent = true;
        break;
      }
    }

    // 4. semantic rules — días sin assignments → rangos contiguos.
    const futureRanges = this.groupContiguousDays(
      daysWithoutAssignments.map((d) => d.date),
    );
    const rulesCreated: Array<{
      startDate: string;
      endDate: string;
      ruleText: string;
    }> = [];
    for (const range of futureRanges) {
      const ruleText = this.composeRuleText(
        employeeName,
        range.start,
        range.end,
        reason,
      );
      try {
        await this.commandBus.execute(
          new CreateSemanticRuleCommand(
            companyId,
            ruleText,
            2, // priority Hard
            'restriction',
            // semantic_rules.created_by es UUID con FK a employees. Si
            // no hay actor, dejamos null (system-generated). El source
            // queda en metadata para auditoría.
            input.createdByUserId ?? undefined,
            {
              source: ruleSource,
              employeeId,
              startDate: range.start,
              endDate: range.end,
            },
            new Date(`${range.end}T23:59:59Z`),
          ),
        );
        rulesCreated.push({
          startDate: range.start,
          endDate: range.end,
          ruleText,
        });
      } catch (err) {
        this.logger.warn(
          `CreateSemanticRule failed for ${ruleSource} range ${range.start}–${range.end}: ${(err as Error).message}`,
        );
      }
    }

    return { deleted, rulesCreated, isUrgent };
  }

  /** Expande un rango YYYY-MM-DD inclusivo a la lista de fechas. */
  private expandDays(startDate: string, endDate: string): string[] {
    const out: string[] = [];
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const last = new Date(`${endDate}T00:00:00Z`);
    while (cursor.getTime() <= last.getTime()) {
      out.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  /** Agrupa fechas consecutivas en rangos. Asume el array está ordenado. */
  private groupContiguousDays(
    dates: string[],
  ): Array<{ start: string; end: string }> {
    if (dates.length === 0) return [];
    const sorted = [...dates].sort();
    const ranges: Array<{ start: string; end: string }> = [];
    let rangeStart = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const expected = new Date(`${prev}T00:00:00Z`);
      expected.setUTCDate(expected.getUTCDate() + 1);
      const expectedISO = expected.toISOString().slice(0, 10);
      if (sorted[i] !== expectedISO) {
        ranges.push({ start: rangeStart, end: prev });
        rangeStart = sorted[i];
      }
      prev = sorted[i];
    }
    ranges.push({ start: rangeStart, end: prev });
    return ranges;
  }

  /**
   * Texto en español natural — el sistema RAG hace embedding y matching.
   * Incluye nombre + rango + razón. Single-day usa "el {date}", multi-day
   * usa "del {start} al {end}".
   */
  private composeRuleText(
    employeeName: string,
    start: string,
    end: string,
    reason: string,
  ): string {
    const period = start === end ? `el ${start}` : `del ${start} al ${end}`;
    const reasonClause = reason.trim() ? ` por ${reason.trim()}` : '';
    return `${employeeName} no trabaja ${period}${reasonClause}.`;
  }
}
