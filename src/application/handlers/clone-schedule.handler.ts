import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CloneScheduleCommand,
  CloneScheduleConflictError,
  type CloneScheduleResult,
  type CloneScheduleSkippedItem,
} from '../commands/clone-schedule.command';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../domain/repositories/shift-assignment.repository';
import {
  DAY_OFF_REQUEST_REPOSITORY,
  type IDayOffRequestRepository,
} from '../../domain/repositories/day-off-request.repository';
import {
  ABSENCE_REPORT_REPOSITORY,
  type IAbsenceReportRepository,
} from '../../domain/repositories/absence-report.repository';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { FairnessHistoryRecomputerService } from '../../domain/services/fairness-history-recomputer.service';
import { CompanyPreferencesService } from '../services/company-preferences.service';
import { weekStartOf } from '../../domain/shared/week';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * CloneScheduleHandler
 *
 * Estrategia: leer source una vez + leer day_offs/absences cubriendo
 * todas las target weeks de una sola pasada + insert por bulk-save.
 *
 * Por qué no usamos un único upsert raw: el aggregate ShiftAssignment
 * valida invariantes (date format, end > start), y el repo.save ya hace
 * upsert por id — usar el camino estándar mantiene los hooks de RLS y
 * audit log consistentes. La performance es aceptable para una semana
 * típica (~30-50 assignments × 4 target weeks = ~200 inserts).
 */
@CommandHandler(CloneScheduleCommand)
export class CloneScheduleHandler implements ICommandHandler<
  CloneScheduleCommand,
  CloneScheduleResult
> {
  private readonly logger = new Logger(CloneScheduleHandler.name);

  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(DAY_OFF_REQUEST_REPOSITORY)
    private readonly dayOffRepo: IDayOffRequestRepository,
    @Inject(ABSENCE_REPORT_REPOSITORY)
    private readonly absenceRepo: IAbsenceReportRepository,
    private readonly fairnessRecomputer: FairnessHistoryRecomputerService,
    private readonly companyPreferences: CompanyPreferencesService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  async execute(command: CloneScheduleCommand): Promise<CloneScheduleResult> {
    const {
      companyId,
      sourceWeekStart,
      targetWeekStarts,
      overwrite,
      employeeId,
      dayOfWeek,
    } = command;

    if (targetWeekStarts.length === 0) {
      return { created: 0, skipped: [], replaced: [] };
    }
    // Defensa: el caller podría pedir cloning a la misma semana — eso
    // sería autodestructivo (delete + reinsert idénticas con ids nuevos
    // perdiendo audit log). Filtramos.
    const targets = targetWeekStarts.filter((ws) => ws !== sourceWeekStart);
    if (targets.length === 0) {
      return { created: 0, skipped: [], replaced: [] };
    }

    const weekStartsOn =
      await this.companyPreferences.getWeekStartsOn(companyId);

    // 1) Source assignments (origen del clone). Clone granular: filtra
    // por employeeId y/o dayOfWeek si vienen del DTO. Sin filtros =
    // toda la semana (back-compat con clone full-week).
    const sourceFrom = sourceWeekStart;
    const sourceTo = this._weekEnd(sourceWeekStart);
    const allSource = await this.assignmentRepo.findByCompanyAndDateRange(
      companyId,
      sourceFrom,
      sourceTo,
    );
    const source = allSource.filter((a) => {
      if (employeeId && a.employeeId !== employeeId) return false;
      if (dayOfWeek !== null && dayOfWeek !== undefined) {
        const dow = new Date(`${a.date}T00:00:00.000Z`).getUTCDay();
        if (dow !== dayOfWeek) return false;
      }
      return true;
    });
    if (source.length === 0) {
      return { created: 0, skipped: [], replaced: [] };
    }

    // 2) Pre-check de conflictos: ¿alguna target week ya tiene assignments
    // EN EL SCOPE del clone? Para clone full-week es la semana entera; para
    // granular es solo el subset filtrado. Sin esto, clonar la fila de
    // Pablo a una semana que ya tiene 50 turnos de otros empleados
    // tiraría 409 falsamente.
    const existingByWeek = await Promise.all(
      targets.map(async (ws) => {
        const allRows = await this.assignmentRepo.findByCompanyAndDateRange(
          companyId,
          ws,
          this._weekEnd(ws),
        );
        const rows = allRows.filter((a) => {
          if (employeeId && a.employeeId !== employeeId) return false;
          if (dayOfWeek !== null && dayOfWeek !== undefined) {
            const dow = new Date(`${a.date}T00:00:00.000Z`).getUTCDay();
            if (dow !== dayOfWeek) return false;
          }
          return true;
        });
        return { weekStart: ws, count: rows.length, rows };
      }),
    );
    const conflicts = existingByWeek.filter((e) => e.count > 0);
    if (conflicts.length > 0 && !overwrite) {
      throw new CloneScheduleConflictError(
        conflicts.map((c) => ({
          weekStart: c.weekStart,
          existingCount: c.count,
        })),
      );
    }

    // 3) Cargar day_offs APPROVED + absences ACTIVAS cubriendo TODAS
    // las targets — una sola pasada por tabla.
    const earliestTarget = [...targets].sort()[0];
    const latestTargetEnd = targets
      .map((ws) => this._weekEnd(ws))
      .sort()
      .reverse()[0];
    const [dayOffs, absences] = await Promise.all([
      this.dayOffRepo.findAllByCompany(companyId, {
        status: 'approved',
        fromDate: earliestTarget,
        toDate: latestTargetEnd,
      }),
      this.absenceRepo.findActiveInRange(
        companyId,
        earliestTarget,
        latestTargetEnd,
      ),
    ]);
    // Index para lookup O(1) por (employeeId, date).
    const dayOffSet = new Set(dayOffs.map((d) => `${d.employeeId}|${d.date}`));
    // Absences son rangos: índice por empleado con array de [start, end].
    const absencesByEmp = new Map<
      string,
      Array<{ start: string; end: string }>
    >();
    for (const a of absences) {
      const arr = absencesByEmp.get(a.employeeId) ?? [];
      arr.push({ start: a.startDate, end: a.endDate });
      absencesByEmp.set(a.employeeId, arr);
    }

    // 4) Construir las nuevas assignments + skip-list.
    const sourceAnchor = weekStartOf(
      new Date(`${sourceWeekStart}T00:00:00.000Z`),
      weekStartsOn,
    );
    const skipped: CloneScheduleSkippedItem[] = [];
    const toInsertByWeek = new Map<string, ShiftAssignment[]>();
    // Set de (employeeId, weekStart) para disparar fairness recompute después.
    const affectedFairness = new Set<string>();

    for (const ws of targets) {
      const targetAnchor = weekStartOf(
        new Date(`${ws}T00:00:00.000Z`),
        weekStartsOn,
      );
      const dayOffsetMs = targetAnchor.getTime() - sourceAnchor.getTime();
      const insertsForWeek: ShiftAssignment[] = [];
      for (const src of source) {
        const newDate = this._addDaysToIso(src.date, dayOffsetMs);
        // Conflicto: day_off aprobado para ese empleado/fecha.
        if (dayOffSet.has(`${src.employeeId}|${newDate}`)) {
          skipped.push({
            employeeId: src.employeeId,
            date: newDate,
            reason: 'day_off',
          });
          continue;
        }
        // Conflicto: absence activa que cubre esa fecha.
        const empAbsences = absencesByEmp.get(src.employeeId);
        if (empAbsences?.some((a) => newDate >= a.start && newDate <= a.end)) {
          skipped.push({
            employeeId: src.employeeId,
            date: newDate,
            reason: 'absence',
          });
          continue;
        }
        // Remapeamos también actualStart/End — son ISO con día concreto.
        // Mantenemos la hora-de-pared del source desplazando solo la fecha.
        const newStart = new Date(src.actualStartTime.getTime() + dayOffsetMs);
        const newEnd = new Date(src.actualEndTime.getTime() + dayOffsetMs);
        insertsForWeek.push(
          ShiftAssignment.create({
            id: randomUUID(),
            templateId: src.templateId,
            date: newDate,
            employeeId: src.employeeId,
            companyId,
            // origin='exception' — fue creado por una acción manual
            // (clone) fuera del flow del solver. Permite distinguir en
            // audit/reports vs membership.
            origin: 'exception',
            strategyType: 'hybrid',
            fairnessSnapshot: {},
            actualStartTime: newStart,
            actualEndTime: newEnd,
            // Clonar también la localidad del turno origen (el manager la
            // cambia después si quiere).
            locationId: src.locationId,
          }),
        );
        affectedFairness.add(`${src.employeeId}|${ws}`);
      }
      toInsertByWeek.set(ws, insertsForWeek);
    }

    // 5) Borrar lo existente en las targets (solo si overwrite).
    //   - Full-week clone (sin filtros): borramos el rango completo de
    //     la semana via deleteByDateRange.
    //   - Granular (employeeId / dayOfWeek): borramos solo los rows
    //     filtrados (ya los tenemos en `conflicts[i].rows`) via
    //     deleteByIdsBatch — preserva el resto de la semana.
    const replaced: Array<{ weekStart: string; count: number }> = [];
    const granular =
      !!employeeId || (dayOfWeek !== null && dayOfWeek !== undefined);
    if (overwrite) {
      for (const c of conflicts) {
        let deletedCount: number;
        if (granular) {
          const ids = c.rows.map((a) => a.id);
          if (ids.length > 0) {
            await this.assignmentRepo.deleteByIdsBatch(ids, companyId);
          }
          deletedCount = ids.length;
        } else {
          deletedCount = await this.assignmentRepo.deleteByDateRange(
            companyId,
            c.weekStart,
            this._weekEnd(c.weekStart),
          );
        }
        replaced.push({ weekStart: c.weekStart, count: deletedCount });
        // Borradas → también afectan fairness de esos empleados.
        for (const a of c.rows) {
          affectedFairness.add(`${a.employeeId}|${c.weekStart}`);
        }
      }
    }

    // 6) Bulk save.
    let created = 0;
    for (const inserts of toInsertByWeek.values()) {
      // No hay un saveMany en el repo; los rows individuales son baratos
      // (~30 por semana) y queremos audit log por fila igualmente. Si
      // performance se vuelve issue, exponemos saveBatch en el repo.
      for (const a of inserts) {
        await this.assignmentRepo.save(a);
        created++;
      }
    }

    // 7) Recompute fairness para cada (employee, week) tocada — incluye
    // los empleados afectados por delete (overwrite) además de los
    // recién insertados.
    for (const key of affectedFairness) {
      const [employeeId, weekStartIso] = key.split('|');
      try {
        const weekStart = weekStartOf(
          new Date(`${weekStartIso}T00:00:00.000Z`),
          weekStartsOn,
        );
        await this.fairnessRecomputer.recomputeForEmployeeWeek(
          companyId,
          employeeId,
          weekStart,
        );
      } catch (err) {
        this.logger.warn(
          `fairness recompute failed after clone for emp=${employeeId} week=${weekStartIso}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // 8) Notificación: la grilla de cualquier manager mirando ya refresca.
    this.notificationsGateway.notifyAssignmentChanged(companyId);

    return { created, skipped, replaced };
  }

  /** YYYY-MM-DD del último día de la semana que arranca en `ws`. */
  private _weekEnd(ws: string): string {
    const d = new Date(`${ws}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  }

  /** Suma `offsetMs` a una fecha ISO YYYY-MM-DD y devuelve la nueva ISO. */
  private _addDaysToIso(iso: string, offsetMs: number): string {
    const d = new Date(`${iso}T00:00:00.000Z`);
    return new Date(d.getTime() + offsetMs).toISOString().slice(0, 10);
  }
}
