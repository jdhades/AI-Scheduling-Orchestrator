import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GetEmployeeCalendarQuery } from '../queries/get-employee-calendar.query';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import {
  SHIFT_ASSIGNMENT_BREAK_REPOSITORY,
  type IShiftAssignmentBreakRepository,
} from '../../domain/repositories/shift-assignment-break.repository';

const FAR_PAST = '1970-01-01';
const FAR_FUTURE = '9999-12-31';

/**
 * Shape devuelto al cliente — assignment + templateName resuelto.
 * El nombre del template es lo que el empleado quiere ver ("Caja Mañana",
 * "Cocina Tarde"), no un UUID. Lo resolvemos en el handler para evitar
 * que el frontend tenga que hacer N queries de templates.
 */
export interface EmployeeCalendarAssignmentDTO {
  id: string;
  employeeId: string;
  templateId: string;
  templateName: string;
  date: string;
  actualStartTime: string;
  actualEndTime: string;
  /** null = turno sin confirmar (el empleado puede confirmarlo). */
  confirmedAt: string | null;
  locationName: string | null;
  breaks: { startTime: string; endTime: string; isPaid: boolean }[];
}

/**
 * GetEmployeeCalendarHandler — Query Handler (CQRS read side).
 * Devuelve las ShiftAssignment del empleado en el rango solicitado,
 * con templateName hidratado.
 */
@QueryHandler(GetEmployeeCalendarQuery)
export class GetEmployeeCalendarHandler implements IQueryHandler<
  GetEmployeeCalendarQuery,
  EmployeeCalendarAssignmentDTO[]
> {
  constructor(
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly templateRepo: IShiftTemplateRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    @Inject(SHIFT_ASSIGNMENT_BREAK_REPOSITORY)
    private readonly breakRepo: IShiftAssignmentBreakRepository,
  ) {}

  async execute(
    query: GetEmployeeCalendarQuery,
  ): Promise<EmployeeCalendarAssignmentDTO[]> {
    const from = query.from ? query.from.toISOString().split('T')[0] : FAR_PAST;
    const to = query.to ? query.to.toISOString().split('T')[0] : FAR_FUTURE;
    const [assignments, templates] = await Promise.all([
      this.assignmentRepo.findByEmployeeAndDateRange(
        query.employeeId,
        query.companyId,
        from,
        to,
      ),
      this.templateRepo.findAllByCompany(query.companyId),
    ]);

    // El aggregate no modela confirmed_at; lo traemos con un side-query (junto
    // con la location) para no tocar el dominio core.
    const ids = assignments.map((a) => a.id);
    const meta = new Map<
      string,
      { confirmedAt: string | null; locationId: string | null }
    >();
    if (ids.length) {
      const { data } = await this.supabase
        .from('shift_assignments')
        .select('id, confirmed_at, location_id')
        .in('id', ids);
      for (const r of (data ?? []) as Array<{
        id: string;
        confirmed_at: string | null;
        location_id: string | null;
      }>) {
        meta.set(r.id, {
          confirmedAt: r.confirmed_at,
          locationId: r.location_id,
        });
      }
    }
    const locIds = [
      ...new Set(
        [...meta.values()]
          .map((m) => m.locationId)
          .filter((l): l is string => !!l),
      ),
    ];
    const locName = new Map<string, string>();
    if (locIds.length) {
      const { data } = await this.supabase
        .from('locations')
        .select('id, name')
        .in('id', locIds);
      for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
        locName.set(r.id, r.name);
      }
    }

    // Breaks por assignment (descansos intra-turno).
    const breaksByAssignment = new Map<
      string,
      { startTime: string; endTime: string; isPaid: boolean }[]
    >();
    if (ids.length) {
      const allBreaks = await this.breakRepo.findByAssignmentIds(
        ids,
        query.companyId,
      );
      for (const b of allBreaks) {
        const list = breaksByAssignment.get(b.assignmentId) ?? [];
        list.push({
          startTime: b.startTime.toISOString(),
          endTime: b.endTime.toISOString(),
          isPaid: b.isPaid,
        });
        breaksByAssignment.set(b.assignmentId, list);
      }
    }

    const nameById = new Map(templates.map((t) => [t.id, t.name]));
    return assignments.map((a) => {
      const m = meta.get(a.id);
      return {
        id: a.id,
        employeeId: a.employeeId,
        templateId: a.templateId,
        templateName: nameById.get(a.templateId) ?? '—',
        date: a.date,
        actualStartTime: a.actualStartTime.toISOString(),
        actualEndTime: a.actualEndTime.toISOString(),
        confirmedAt: m?.confirmedAt ?? null,
        locationName: m?.locationId
          ? (locName.get(m.locationId) ?? null)
          : null,
        breaks: breaksByAssignment.get(a.id) ?? [],
      };
    });
  }
}
