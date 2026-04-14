import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftMembership } from '../../domain/aggregates/shift-membership.aggregate';
import type { IShiftMembershipRepository } from '../../domain/repositories/shift-membership.repository';

@Injectable()
export class SupabaseShiftMembershipRepository implements IShiftMembershipRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(membership: ShiftMembership): Promise<void> {
    const { error } = await this.supabase.from('shift_memberships').upsert({
      id: membership.id,
      company_id: membership.companyId,
      employee_id: membership.employeeId,
      template_id: membership.templateId,
      effective_from: membership.effectiveFrom,
      effective_until: membership.effectiveUntil,
    });
    if (error) throw new Error(`ShiftMembershipRepository.save: ${error.message}`);
  }

  async delete(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('shift_memberships')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw new Error(`ShiftMembershipRepository.delete: ${error.message}`);
  }

  async findById(id: string, companyId: string): Promise<ShiftMembership | null> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) throw new Error(`ShiftMembershipRepository.findById: ${error.message}`);
    return data ? ShiftMembership.fromPersistence(data as never) : null;
  }

  async findActiveOnDate(
    companyId: string,
    dateISO: string,
  ): Promise<ShiftMembership[]> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('company_id', companyId)
      .lte('effective_from', dateISO)
      .or(`effective_until.is.null,effective_until.gte.${dateISO}`);
    if (error) throw new Error(`ShiftMembershipRepository.findActiveOnDate: ${error.message}`);
    return (data ?? []).map((r) => ShiftMembership.fromPersistence(r as never));
  }

  async findActiveInRange(
    companyId: string,
    fromISO: string,
    toISO: string,
  ): Promise<ShiftMembership[]> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('company_id', companyId)
      .lte('effective_from', toISO)
      .or(`effective_until.is.null,effective_until.gte.${fromISO}`);
    if (error) throw new Error(`ShiftMembershipRepository.findActiveInRange: ${error.message}`);
    return (data ?? []).map((r) => ShiftMembership.fromPersistence(r as never));
  }

  async findByEmployee(
    employeeId: string,
    companyId: string,
  ): Promise<ShiftMembership[]> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId);
    if (error) throw new Error(`ShiftMembershipRepository.findByEmployee: ${error.message}`);
    return (data ?? []).map((r) => ShiftMembership.fromPersistence(r as never));
  }

  async findByTemplate(
    templateId: string,
    companyId: string,
  ): Promise<ShiftMembership[]> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('company_id', companyId)
      .eq('template_id', templateId);
    if (error) throw new Error(`ShiftMembershipRepository.findByTemplate: ${error.message}`);
    return (data ?? []).map((r) => ShiftMembership.fromPersistence(r as never));
  }
}
