import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetCompanyScheduleQuery } from '../queries/get-company-schedule.query';
import {
  SHIFT_ASSIGNMENT_REPOSITORY,
  type IShiftAssignmentRepository,
} from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';

/**
 * Vista plana de una asignación para la grilla del frontend.
 * Post-rework V3 (Phase 13) ya no hay tabla `shifts` — los datos
 * temporales viven directos en `shift_assignments.actual_start_time/
 * actual_end_time`. El template se resuelve via `template_id`.
 */
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
      };
    });
  }
}
