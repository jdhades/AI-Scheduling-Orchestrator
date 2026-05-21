import { Inject, Injectable } from '@nestjs/common';
import type { IShiftAssignmentRepository } from '../repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../repositories/shift-template.repository';
import type { ShiftTemplate } from '../aggregates/shift-template.aggregate';
import { weekStartOf, type WeekStartsOn } from '../shared/week';

export interface CoverageCell {
  /** Hora del día (0-23). */
  hour: number;
  assigned: number;
  required: number;
}

export interface CoverageDay {
  /** ISO date (YYYY-MM-DD) que corresponde a este día de la semana. */
  date: string;
  /** dayOfWeek convencional JS: 0=Dom..6=Sáb. */
  dayOfWeek: number;
  cells: CoverageCell[];
}

export interface CoverageReport {
  weekStart: string; // ISO
  hours: number[];   // ej [8, 9, ..., 21]
  days: CoverageDay[];
}

/**
 * CoverageService — calcula la cobertura de plantilla por (día × hora) para
 * una semana puntual.
 *
 * Definiciones v1:
 *   - `required(día, hora)` = suma de `template.requiredEmployees` para los
 *     templates activos cuyo `dayOfWeek` matchea el día y cuyo rango horario
 *     `[startTime, endTime)` cubre la hora. `dayOfWeek === null` → genérico,
 *     aplica a todos los días.
 *   - `assigned(día, hora)` = cantidad de `ShiftAssignment` para esa fecha
 *     cuyo template-cover-ese-rango (mismo criterio que required).
 *
 * Limitaciones conocidas:
 *   - Turnos que cruzan medianoche (`endTime <= startTime`) NO se reportan
 *     en las horas post-midnight del día siguiente. v1.
 *   - `requiredEmployees` se asume constante a lo largo del turno (mismo
 *     valor en todas las horas que el turno cubre). v1.
 */
@Injectable()
export class CoverageService {
  // TODO(hardcode): rango horario 08-21 fijo — algunos negocios operan
  // fuera (gastronomía nocturna, salud 24/7). Cómo sacarlo: agregar
  // `companies.business_hours_start/end` o derivar de min/max(templates).
  // v1 fijo para alinear con la UI legacy del CoverageHeatmap.
  static readonly HOURS_RANGE = Array.from({ length: 14 }, (_, i) => 8 + i);

  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
  ) {}

  async getWeekCoverage(
    companyId: string,
    weekStartIso: string,
    weekStartsOn: WeekStartsOn,
  ): Promise<CoverageReport> {
    const anchor = weekStartOf(
      new Date(`${weekStartIso}T00:00:00.000Z`),
      weekStartsOn,
    );
    const anchorIso = anchor.toISOString().split('T')[0];
    const end = new Date(anchor);
    end.setUTCDate(end.getUTCDate() + 6);
    const endIso = end.toISOString().split('T')[0];

    const [templates, assignments] = await Promise.all([
      this.templateRepo.findAllByCompany(companyId),
      this.assignmentRepo.findByCompanyAndDateRange(companyId, anchorIso, endIso),
    ]);
    const activeTemplates = templates.filter((t) => t.isActive);
    const templateById = new Map(activeTemplates.map((t) => [t.id, t]));

    // Index assignments por fecha → templateId → count.
    const assignedByDateTpl = new Map<string, Map<string, number>>();
    for (const a of assignments) {
      let perTpl = assignedByDateTpl.get(a.date);
      if (!perTpl) {
        perTpl = new Map();
        assignedByDateTpl.set(a.date, perTpl);
      }
      perTpl.set(a.templateId, (perTpl.get(a.templateId) ?? 0) + 1);
    }

    const days: CoverageDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(anchor);
      date.setUTCDate(date.getUTCDate() + i);
      const dateIso = date.toISOString().split('T')[0];
      const dow = date.getUTCDay();

      const matchingTemplates = activeTemplates.filter(
        (t) => t.dayOfWeek === null || t.dayOfWeek === dow,
      );
      const perTpl = assignedByDateTpl.get(dateIso) ?? new Map();

      const cells: CoverageCell[] = CoverageService.HOURS_RANGE.map((hour) => {
        let required = 0;
        let assigned = 0;
        for (const tpl of matchingTemplates) {
          if (!this.templateCoversHour(tpl, hour)) continue;
          required += tpl.requiredEmployees ?? 0;
          assigned += perTpl.get(tpl.id) ?? 0;
          // Si hay assignments para un template cuyo `requiredEmployees` es
          // null, igual los contamos como asignados — son trabajo realizado.
          // No suman al `required` (no hay número), pero sí al `assigned`.
        }
        return { hour, assigned, required };
      });

      days.push({ date: dateIso, dayOfWeek: dow, cells });
    }

    return {
      weekStart: anchorIso,
      hours: CoverageService.HOURS_RANGE,
      days,
    };
  }

  /**
   * ¿El template cubre `hour:00`? Compara hora-de-inicio (inclusive) con
   * hora-de-fin (exclusive). Ignora turnos overnight (v1).
   */
  private templateCoversHour(tpl: ShiftTemplate, hour: number): boolean {
    const startH = Number(tpl.startTime.slice(0, 2));
    const endH = Number(tpl.endTime.slice(0, 2));
    if (endH <= startH) return false; // overnight — v1 fuera de scope
    return hour >= startH && hour < endH;
  }
}
