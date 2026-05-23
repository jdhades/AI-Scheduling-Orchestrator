import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../repositories/shift-assignment.repository';
import {
  SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
  type IShiftAssignmentBreakRepository,
} from '../repositories/shift-assignment-break.repository';
import {
  FAIRNESS_HISTORY_REPOSITORY,
  type IFairnessHistoryRepository,
} from '../repositories/fairness-history.repository';
import type { IShiftTemplateRepository } from '../repositories/shift-template.repository';
import { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import { weekStartOf, type WeekStartsOn } from '../shared/week';

/**
 * FairnessHistoryRecomputerService
 *
 * Recomputa `fairness_history` para una fila puntual (employee × week)
 * a partir del estado vigente de assignments + breaks. Esta es la
 * contraparte "single-row" del path batch que corre el generate handler
 * tras una corrida del solver.
 *
 * Motivación: las mutaciones manuales sobre assignments (POST manual,
 * PATCH move, DELETE, take-open-shift, swap-shift) no actualizaban
 * fairness_history — la tabla solo se reescribía al regenerar el
 * horario. Resultado: el dashboard ("Promedio horas / empleado",
 * "Detalles por dimensión", fairness CV) quedaba mostrando una foto
 * vieja entre regeneraciones, y el manager veía 24h aunque hubiera
 * agregado 6h más.
 *
 * Convención: una vez generado el horario, manual edits actualizan
 * solo las filas de los empleados/semanas afectados — el resto queda
 * intacto. La próxima regeneración igualmente sobrescribe TODA la
 * semana de cero (ver generate-hybrid-schedule.handler.ts), así que
 * inconsistencias temporarias quedan resueltas en el siguiente run.
 */
@Injectable()
export class FairnessHistoryRecomputerService {
  private readonly logger = new Logger(
    FairnessHistoryRecomputerService.name,
  );

  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(SHIFT_ASSIGNMENT_BREAK_REPOSITORY)
    private readonly breakRepo: IShiftAssignmentBreakRepository,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepo: IFairnessHistoryRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
  ) {}

  /**
   * Recomputa y persiste fairness para un (employee, week). Si no hay
   * assignments en esa semana escribe row vacía (hoursWorked=0) — es
   * lo que el batch hace al regenerar también, mantener la fila con
   * ceros es preferible a borrarla porque otros joins esperan que la
   * fila exista.
   */
  async recomputeForEmployeeWeek(
    companyId: string,
    employeeId: string,
    weekStart: Date,
  ): Promise<void> {
    const normalizedStart = new Date(weekStart);
    normalizedStart.setUTCHours(0, 0, 0, 0);
    const weekStartIso = normalizedStart.toISOString().slice(0, 10);
    const weekEnd = new Date(normalizedStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const weekEndIso = weekEnd.toISOString().slice(0, 10);

    const [assignments, templates] = await Promise.all([
      this.assignmentRepo.findByEmployeeAndDateRange(
        employeeId,
        companyId,
        weekStartIso,
        weekEndIso,
      ),
      this.templateRepo.findAllByCompany(companyId),
    ]);
    const templateById = new Map(templates.map((t) => [t.id, t]));

    // Una sola query de breaks para todos los assignments de la semana.
    // Evita N+1 cuando un empleado tiene varios shifts con breaks.
    const allBreaks =
      assignments.length > 0
        ? await this.breakRepo.findByAssignmentIds(
            assignments.map((a) => a.id),
            companyId,
          )
        : [];
    const breaksByAssignment = new Map<
      string,
      Array<{ startTime: Date; endTime: Date; isPaid: boolean }>
    >();
    for (const b of allBreaks) {
      const arr = breaksByAssignment.get(b.assignmentId) ?? [];
      arr.push({
        startTime: b.startTime,
        endTime: b.endTime,
        isPaid: b.isPaid,
      });
      breaksByAssignment.set(b.assignmentId, arr);
    }

    let history = FairnessHistoryVO.empty(
      employeeId,
      companyId,
      normalizedStart,
    );

    for (const a of assignments) {
      const grossMs = a.actualEndTime.getTime() - a.actualStartTime.getTime();
      // end <= start no debería pasar (overnight se representa con la
      // fecha del día siguiente en actualEndTime), pero defensivamente
      // saltamos para no escribir números negativos.
      if (grossMs <= 0) continue;

      const breaks = breaksByAssignment.get(a.id) ?? [];
      const unpaidMs = breaks
        .filter((b) => !b.isPaid)
        .reduce(
          (acc, b) => acc + (b.endTime.getTime() - b.startTime.getTime()),
          0,
        );

      const hoursWorked = Math.max(0, (grossMs - unpaidMs) / 3_600_000);

      const tpl = templateById.get(a.templateId);
      // Mismo umbral que week-schedule-builder.service.ts: normalizado
      // a [0..1], "pesado" si >= 0.5. UndesirableWeight VO expone
      // .normalized() = value / MAX.
      const isUndesirable = tpl
        ? tpl.undesirableWeight.normalized() >= 0.5
        : false;
      // Heurísticas alineadas con SlotVO.isNightShift/isWeekendShift:
      //   - night: el shift toca alguna hora >=22 o <6 (en UTC,
      //     consistente con el storage wall-clock del proyecto).
      //   - weekend: la fecha del assignment cae en sáb (6) o dom (0).
      const startH = a.actualStartTime.getUTCHours();
      const endH = a.actualEndTime.getUTCHours();
      const isNight =
        startH >= 22 || startH < 6 || endH > 22 || endH === 0 || endH < 6;
      const dow = new Date(`${a.date}T00:00:00.000Z`).getUTCDay();
      const isWeekend = dow === 0 || dow === 6;

      history = history.addShift(hoursWorked, {
        isUndesirable,
        isNight,
        isWeekend,
      });
    }

    await this.fairnessRepo.upsert(history);
  }

  /** Helper estático: dado un date ISO YYYY-MM-DD del assignment y la
   * preferencia del tenant, devuelve la Date del weekStart correspondiente
   * (normalizada a 00:00 UTC). */
  static weekStartFromAssignmentDate(
    dateIso: string,
    weekStartsOn: WeekStartsOn,
  ): Date {
    return weekStartOf(
      new Date(`${dateIso}T00:00:00.000Z`),
      weekStartsOn,
    );
  }
}

export const FAIRNESS_HISTORY_RECOMPUTER =
  'FAIRNESS_HISTORY_RECOMPUTER' as const;
