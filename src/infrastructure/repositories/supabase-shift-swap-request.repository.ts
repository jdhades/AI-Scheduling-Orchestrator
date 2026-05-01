import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftSwapRequest } from '../../domain/aggregates/shift-swap-request.aggregate';
import type {
  IShiftSwapRequestRepository,
  ShiftSwapRequestFilter,
} from '../../domain/repositories/shift-swap-request.repository';

@Injectable()
export class SupabaseShiftSwapRequestRepository
  implements IShiftSwapRequestRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(req: ShiftSwapRequest): Promise<void> {
    const { error } = await this.supabase.from('shift_swap_requests').upsert({
      id: req.id,
      company_id: req.companyId,
      requester_id: req.requesterId,
      target_id: req.targetId,
      shift_assignment_id: req.assignmentId,
      status: req.status,
      created_at: req.createdAt.toISOString(),
      approved_by: req.approvedBy,
    });
    if (error)
      throw new Error(`ShiftSwapRequestRepository.save: ${error.message}`);
  }

  async findById(
    id: string,
    companyId: string,
  ): Promise<ShiftSwapRequest | null> {
    const { data, error } = await this.supabase
      .from('shift_swap_requests')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error)
      throw new Error(`ShiftSwapRequestRepository.findById: ${error.message}`);
    return data ? ShiftSwapRequest.fromPersistence(data as never) : null;
  }

  async findAllByCompany(
    companyId: string,
    filter?: ShiftSwapRequestFilter,
  ): Promise<ShiftSwapRequest[]> {
    let q = this.supabase
      .from('shift_swap_requests')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (filter?.requesterId) q = q.eq('requester_id', filter.requesterId);
    if (filter?.targetId) q = q.eq('target_id', filter.targetId);
    if (filter?.status) {
      q = Array.isArray(filter.status)
        ? q.in('status', filter.status)
        : q.eq('status', filter.status);
    }
    const { data, error } = await q;
    if (error)
      throw new Error(
        `ShiftSwapRequestRepository.findAllByCompany: ${error.message}`,
      );
    return (data ?? []).map((r) => ShiftSwapRequest.fromPersistence(r as never));
  }
}
