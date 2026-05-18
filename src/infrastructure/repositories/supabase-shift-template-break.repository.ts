import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftTemplateBreak } from '../../domain/aggregates/shift-template-break.aggregate';
import type { IShiftTemplateBreakRepository } from '../../domain/repositories/shift-template-break.repository';

interface TplBreakRow {
  id: string;
  template_id: string;
  company_id: string;
  start_offset_minutes: number;
  duration_minutes: number;
  is_paid: boolean;
  reason: string | null;
  created_at: string;
}

@Injectable()
export class SupabaseShiftTemplateBreakRepository
  implements IShiftTemplateBreakRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(brk: ShiftTemplateBreak): Promise<void> {
    const { error } = await this.supabase
      .from('shift_template_breaks')
      .upsert({
        id: brk.id,
        template_id: brk.templateId,
        company_id: brk.companyId,
        start_offset_minutes: brk.startOffsetMinutes,
        duration_minutes: brk.durationMinutes,
        is_paid: brk.isPaid,
        reason: brk.reason,
      });
    if (error) {
      throw new Error(
        `ShiftTemplateBreakRepository.save: ${error.message}`,
      );
    }
  }

  async deleteById(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('shift_template_breaks')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) {
      throw new Error(
        `ShiftTemplateBreakRepository.deleteById: ${error.message}`,
      );
    }
  }

  async findByTemplateId(
    templateId: string,
    companyId: string,
  ): Promise<ShiftTemplateBreak[]> {
    const { data, error } = await this.supabase
      .from('shift_template_breaks')
      .select(
        'id, template_id, company_id, start_offset_minutes, duration_minutes, is_paid, reason, created_at',
      )
      .eq('template_id', templateId)
      .eq('company_id', companyId)
      .order('start_offset_minutes', { ascending: true });
    if (error) {
      throw new Error(
        `ShiftTemplateBreakRepository.findByTemplateId: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.rowToAggregate(r as TplBreakRow));
  }

  async findById(
    id: string,
    companyId: string,
  ): Promise<ShiftTemplateBreak | null> {
    const { data, error } = await this.supabase
      .from('shift_template_breaks')
      .select(
        'id, template_id, company_id, start_offset_minutes, duration_minutes, is_paid, reason, created_at',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `ShiftTemplateBreakRepository.findById: ${error.message}`,
      );
    }
    return data ? this.rowToAggregate(data as TplBreakRow) : null;
  }

  private rowToAggregate(r: TplBreakRow): ShiftTemplateBreak {
    return ShiftTemplateBreak.create({
      id: r.id,
      templateId: r.template_id,
      companyId: r.company_id,
      startOffsetMinutes: r.start_offset_minutes,
      durationMinutes: r.duration_minutes,
      isPaid: r.is_paid,
      reason: r.reason,
      createdAt: new Date(r.created_at),
    });
  }
}
