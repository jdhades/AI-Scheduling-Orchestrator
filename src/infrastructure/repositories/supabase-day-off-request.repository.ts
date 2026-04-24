import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DayOffRequest } from '../../domain/aggregates/day-off-request.aggregate';
import type {
  IDayOffRequestRepository,
  DayOffRequestFilter,
} from '../../domain/repositories/day-off-request.repository';

@Injectable()
export class SupabaseDayOffRequestRepository
  implements IDayOffRequestRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(req: DayOffRequest): Promise<void> {
    const { error } = await this.supabase.from('day_off_requests').upsert({
      id: req.id,
      company_id: req.companyId,
      employee_id: req.employeeId,
      date: req.date,
      reason: req.reason,
      status: req.status,
      created_at: req.createdAt.toISOString(),
    });
    if (error)
      throw new Error(`DayOffRequestRepository.save: ${error.message}`);
  }

  async findById(id: string, companyId: string): Promise<DayOffRequest | null> {
    const { data, error } = await this.supabase
      .from('day_off_requests')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error)
      throw new Error(`DayOffRequestRepository.findById: ${error.message}`);
    return data ? DayOffRequest.fromPersistence(data as never) : null;
  }

  async findAllByCompany(
    companyId: string,
    filter?: DayOffRequestFilter,
  ): Promise<DayOffRequest[]> {
    let q = this.supabase
      .from('day_off_requests')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: false });
    if (filter?.employeeId) q = q.eq('employee_id', filter.employeeId);
    if (filter?.status) {
      q = Array.isArray(filter.status)
        ? q.in('status', filter.status)
        : q.eq('status', filter.status);
    }
    if (filter?.fromDate) q = q.gte('date', filter.fromDate);
    if (filter?.toDate) q = q.lte('date', filter.toDate);
    const { data, error } = await q;
    if (error)
      throw new Error(
        `DayOffRequestRepository.findAllByCompany: ${error.message}`,
      );
    return (data ?? []).map((r) => DayOffRequest.fromPersistence(r as never));
  }
}
