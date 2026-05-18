import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetCompanyScheduleQuery } from '../queries/get-company-schedule.query';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../domain/repositories/shift-assignment.repository';
import {
  SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
  type IShiftAssignmentBreakRepository,
} from '../../domain/repositories/shift-assignment-break.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';

/**
 * Vista plana de una asignación para la grilla del frontend.
 * Post-rework V3 (Phase 13) ya no hay tabla `shifts` — los datos
 * temporales viven directos en `shift_assignments.actual_start_time/
 * actual_end_time`. El template se resuelve via `template_id`.
 */
export interface CompanyScheduleAssignmentBreakDTO {
  id: string;
  /** ISO UTC absoluto. */
  startTime: string;
  endTime: string;
  isPaid: boolean;
}

export interface CompanyScheduleAssignmentDTO {
  id: string;
  employeeId: string;
  templateId: string;
  templateName: string;
  /** YYYY-MM-DD — fecha lógica del slot. */
  date: string;
  /** ISO datetime UTC — inicio real del turno. */
  actualStartTime: string;
  /** ISO datetime UTC — fin real (puede cruzar medianoche para overnight). */
  actualEndTime: string;
  origin: 'membership' | 'override' | 'exception';
  /** Breaks intra-shift del assignment. Lista ordenada por startTime
   * ASC. Vacío si el shift no tiene descansos. Permite al frontend
   * renderear el badge ☕ + count sin un fetch separado por bloque. */
  breaks: CompanyScheduleAssignmentBreakDTO[];
}

/**
 * GetCompanyScheduleHandler — Query Handler
 *
 * Devuelve todas las assignments del tenant para la semana indicada
 * (lun → dom). Phase 14 — opcional filter por departmentId via los
 * templates del depto.
 *
 * Post-rework V3: usa `IShiftAssignmentRepository.findByCompanyAndDateRange`.
 * La implementación vieja vivía en `IShiftRepository.findAssignmentsByCompanyAndWeek`
 * y hacía JOIN contra la tabla `shifts` que YA NO EXISTE — devolvía
 * siempre [] silenciosamente.
 */
@QueryHandler(GetCompanyScheduleQuery)
export class GetCompanyScheduleHandler
  implements
    IQueryHandler<GetCompanyScheduleQuery, CompanyScheduleAssignmentDTO[]>
{
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    @Inject(SHIFT_ASSIGNMENT_BREAK_REPOSITORY)
    private readonly breakRepo: IShiftAssignmentBreakRepository,
  ) {}

  async execute(
    query: GetCompanyScheduleQuery,
  ): Promise<CompanyScheduleAssignmentDTO[]> {
    const weekStart = query.weekStart;
    // weekStart es 'YYYY-MM-DD' del lunes; weekEnd = +6 días = domingo.
    const startDate = new Date(`${weekStart}T00:00:00.000Z`);
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 6);
    const weekEnd = endDate.toISOString().slice(0, 10);

    const [assignments, templates] = await Promise.all([
      this.assignmentRepo.findByCompanyAndDateRange(
        query.companyId,
        weekStart,
        weekEnd,
      ),
      this.templateRepo.findAllByCompany(query.companyId),
    ]);

    const templateById = new Map(templates.map((t) => [t.id, t]));

    let filtered = query.departmentId
      ? assignments.filter((a) => {
          const tpl = templateById.get(a.templateId);
          return tpl?.departmentId === query.departmentId;
        })
      : assignments;

    // Filtro por empleado — usado por la vista `/my` del empleado.
    if (query.employeeId) {
      filtered = filtered.filter((a) => a.employeeId === query.employeeId);
    }

    // Hidratar breaks en un solo round-trip — sin esto, render del
    // badge ☕ por bloque dispararía N queries (N = assignments en la
    // semana). El repo expone findByAssignmentIds para esto.
    const assignmentIds = filtered.map((a) => a.id);
    const allBreaks = await this.breakRepo.findByAssignmentIds(
      assignmentIds,
      query.companyId,
    );
    const breaksByAssignmentId = new Map<
      string,
      CompanyScheduleAssignmentBreakDTO[]
    >();
    for (const b of allBreaks) {
      const list = breaksByAssignmentId.get(b.assignmentId) ?? [];
      list.push({
        id: b.id,
        startTime: b.startTime.toISOString(),
        endTime: b.endTime.toISOString(),
        isPaid: b.isPaid,
      });
      breaksByAssignmentId.set(b.assignmentId, list);
    }

    return filtered.map((a) => {
      const tpl = templateById.get(a.templateId);
      return {
        id: a.id,
        employeeId: a.employeeId,
        templateId: a.templateId,
        templateName: tpl?.name ?? '(template borrado)',
        date: a.date,
        actualStartTime: a.actualStartTime.toISOString(),
        actualEndTime: a.actualEndTime.toISOString(),
        origin: a.origin,
        breaks: breaksByAssignmentId.get(a.id) ?? [],
      };
    });
  }
}
