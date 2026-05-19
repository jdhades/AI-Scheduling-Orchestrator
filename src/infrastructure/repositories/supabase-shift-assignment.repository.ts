import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftAssignment, type AssignmentOrigin } from '../../domain/aggregates/shift-assignment.aggregate';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import type { StrategyType } from '../../domain/types/scheduling-types';

@Injectable()
export class SupabaseShiftAssignmentRepository
  implements IShiftAssignmentRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(assignment: ShiftAssignment): Promise<void> {
    const { error } = await this.supabase.from('shift_assignments').upsert({
      id: assignment.id,
      template_id: assignment.templateId,
      date: assignment.date,
      origin: assignment.origin,
      employee_id: assignment.employeeId,
      company_id: assignment.companyId,
      assigned_at: assignment.assignedAt.toISOString(),
      assigned_by_strategy: assignment.assignedByStrategy,
      fairness_snapshot: assignment.fairnessSnapshot,
      actual_start_time: assignment.actualStartTime.toISOString(),
      actual_end_time: assignment.actualEndTime.toISOString(),
    });
    if (error) {
      throw new Error(`ShiftAssignmentRepository.save: ${error.message}`);
    }
  }

  async deleteById(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('shift_assignments')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) {
      throw new Error(`ShiftAssignmentRepository.deleteById: ${error.message}`);
    }
  }

  async deleteByIdsBatch(
    ids: string[],
    companyId: string,
  ): Promise<Array<{ id: string; templateId: string; date: string }>> {
    if (ids.length === 0) return [];
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .delete()
      .in('id', ids)
      .eq('company_id', companyId)
      .select('id, template_id, date');
    if (error) {
      throw new Error(
        `ShiftAssignmentRepository.deleteByIdsBatch: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      templateId: r.template_id as string,
      date: r.date as string,
    }));
  }

  async deleteByDateRange(
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
    templateIds?: string[],
  ): Promise<number> {
    // Si templateIds está presente pero vacío, no hay nada que borrar
    // (evita el caso "in()" sin valores que en algunas queries
    // PostgREST se interpreta como "true").
    if (templateIds !== undefined && templateIds.length === 0) {
      return 0;
    }

    let q = this.supabase
      .from('shift_assignments')
      .delete()
      .eq('company_id', companyId)
      .gte('date', fromDateISO)
      .lte('date', toDateISO);
    if (templateIds && templateIds.length > 0) {
      q = q.in('template_id', templateIds);
    }
    const { data, error } = await q.select('id');
    if (error) {
      throw new Error(
        `ShiftAssignmentRepository.deleteByDateRange: ${error.message}`,
      );
    }
    return (data ?? []).length;
  }

  async findById(id: string, companyId: string): Promise<ShiftAssignment | null> {
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      throw new Error(`ShiftAssignmentRepository.findById: ${error.message}`);
    }
    return data ? this.toDomain(data) : null;
  }

  async findByEmployeeAndDateRange(
    employeeId: string,
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
  ): Promise<ShiftAssignment[]> {
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .select('*')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .gte('date', fromDateISO)
      .lte('date', toDateISO)
      .order('date', { ascending: true });
    if (error) {
      throw new Error(
        `ShiftAssignmentRepository.findByEmployeeAndDateRange: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.toDomain(r));
  }

  async findByCompanyAndDateRange(
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
  ): Promise<ShiftAssignment[]> {
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .select('*')
      .eq('company_id', companyId)
      .gte('date', fromDateISO)
      .lte('date', toDateISO)
      .order('date', { ascending: true });
    if (error) {
      throw new Error(
        `ShiftAssignmentRepository.findByCompanyAndDateRange: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.toDomain(r));
  }

  async findBySlot(
    templateId: string,
    dateISO: string,
    companyId: string,
  ): Promise<ShiftAssignment[]> {
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .select('*')
      .eq('company_id', companyId)
      .eq('template_id', templateId)
      .eq('date', dateISO);
    if (error) {
      throw new Error(`ShiftAssignmentRepository.findBySlot: ${error.message}`);
    }
    return (data ?? []).map((r) => this.toDomain(r));
  }

  async resolveShortId(
    shortId: string,
    companyId: string,
  ): Promise<string | null> {
    const trimmed = shortId.trim();
    if (!trimmed) return null;
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .select('id')
      .eq('company_id', companyId)
      .ilike('id', `${trimmed}%`)
      .limit(2);
    if (error) {
      throw new Error(
        `ShiftAssignmentRepository.resolveShortId: ${error.message}`,
      );
    }
    if (!data || data.length !== 1) return null;
    return data[0].id as string;
  }

  private toDomain(row: Record<string, any>): ShiftAssignment {
    return ShiftAssignment.fromPersistence({
      id: row.id,
      templateId: row.template_id,
      date: row.date,
      employeeId: row.employee_id,
      companyId: row.company_id,
      origin: (row.origin ?? 'membership') as AssignmentOrigin,
      assignedAt: new Date(row.assigned_at),
      assignedByStrategy: (row.assigned_by_strategy ?? 'hybrid') as StrategyType,
      fairnessSnapshot: row.fairness_snapshot ?? {},
      actualStartTime: new Date(row.actual_start_time),
      actualEndTime: new Date(row.actual_end_time),
    });
  }
}
