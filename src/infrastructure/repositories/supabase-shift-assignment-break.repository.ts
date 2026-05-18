import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftAssignmentBreak } from '../../domain/aggregates/shift-assignment-break.aggregate';
import type { IShiftAssignmentBreakRepository } from '../../domain/repositories/shift-assignment-break.repository';

interface BreakRow {
  id: string;
  assignment_id: string;
  company_id: string;
  start_time: string;
  end_time: string;
  is_paid: boolean;
  reason: string | null;
  created_at: string;
}

@Injectable()
export class SupabaseShiftAssignmentBreakRepository
  implements IShiftAssignmentBreakRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(brk: ShiftAssignmentBreak): Promise<void> {
    const { error } = await this.supabase
      .from('shift_assignment_breaks')
      .upsert({
        id: brk.id,
        assignment_id: brk.assignmentId,
        company_id: brk.companyId,
        start_time: brk.startTime.toISOString(),
        end_time: brk.endTime.toISOString(),
        is_paid: brk.isPaid,
        reason: brk.reason,
      });
    if (error) {
      throw new Error(
        `ShiftAssignmentBreakRepository.save: ${error.message}`,
      );
    }
  }

  async deleteById(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('shift_assignment_breaks')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) {
      throw new Error(
        `ShiftAssignmentBreakRepository.deleteById: ${error.message}`,
      );
    }
  }

  async deleteByAssignmentId(
    assignmentId: string,
    companyId: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('shift_assignment_breaks')
      .delete()
      .eq('assignment_id', assignmentId)
      .eq('company_id', companyId);
    if (error) {
      throw new Error(
        `ShiftAssignmentBreakRepository.deleteByAssignmentId: ${error.message}`,
      );
    }
  }

  async findByAssignmentId(
    assignmentId: string,
    companyId: string,
  ): Promise<ShiftAssignmentBreak[]> {
    const { data, error } = await this.supabase
      .from('shift_assignment_breaks')
      .select(
        'id, assignment_id, company_id, start_time, end_time, is_paid, reason, created_at',
      )
      .eq('assignment_id', assignmentId)
      .eq('company_id', companyId)
      .order('start_time', { ascending: true });
    if (error) {
      throw new Error(
        `ShiftAssignmentBreakRepository.findByAssignmentId: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.rowToAggregate(r as BreakRow));
  }

  async findByAssignmentIds(
    assignmentIds: string[],
    companyId: string,
  ): Promise<ShiftAssignmentBreak[]> {
    if (assignmentIds.length === 0) return [];
    const { data, error } = await this.supabase
      .from('shift_assignment_breaks')
      .select(
        'id, assignment_id, company_id, start_time, end_time, is_paid, reason, created_at',
      )
      .in('assignment_id', assignmentIds)
      .eq('company_id', companyId)
      .order('start_time', { ascending: true });
    if (error) {
      throw new Error(
        `ShiftAssignmentBreakRepository.findByAssignmentIds: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.rowToAggregate(r as BreakRow));
  }

  async findById(
    id: string,
    companyId: string,
  ): Promise<ShiftAssignmentBreak | null> {
    const { data, error } = await this.supabase
      .from('shift_assignment_breaks')
      .select(
        'id, assignment_id, company_id, start_time, end_time, is_paid, reason, created_at',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `ShiftAssignmentBreakRepository.findById: ${error.message}`,
      );
    }
    return data ? this.rowToAggregate(data as BreakRow) : null;
  }

  private rowToAggregate(r: BreakRow): ShiftAssignmentBreak {
    return ShiftAssignmentBreak.create({
      id: r.id,
      assignmentId: r.assignment_id,
      companyId: r.company_id,
      startTime: new Date(r.start_time),
      endTime: new Date(r.end_time),
      isPaid: r.is_paid,
      reason: r.reason,
      createdAt: new Date(r.created_at),
    });
  }
}
