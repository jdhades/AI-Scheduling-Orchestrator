import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftAssignment, type AssignmentOrigin } from '../../domain/aggregates/shift-assignment.aggregate';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import type { StrategyType } from '../../domain/strategies/scheduling-strategy.interface';

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
      actual_start_time: assignment.actualStartTime?.toISOString() ?? null,
      actual_end_time: assignment.actualEndTime?.toISOString() ?? null,
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

  async deleteByDateRange(
    companyId: string,
    fromDateISO: string,
    toDateISO: string,
  ): Promise<number> {
    const { data, error } = await this.supabase
      .from('shift_assignments')
      .delete()
      .eq('company_id', companyId)
      .gte('date', fromDateISO)
      .lte('date', toDateISO)
      .select('id');
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
      actualStartTime: row.actual_start_time
        ? new Date(row.actual_start_time)
        : undefined,
      actualEndTime: row.actual_end_time ? new Date(row.actual_end_time) : undefined,
    });
  }
}
