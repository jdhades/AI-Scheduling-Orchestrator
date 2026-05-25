import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShiftMembership } from '../../domain/aggregates/shift-membership.aggregate';
import type {
  IShiftMembershipRepository,
  ShiftMembershipFilter,
} from '../../domain/repositories/shift-membership.repository';

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
    if (error)
      throw new Error(`ShiftMembershipRepository.save: ${error.message}`);
  }

  async delete(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('shift_memberships')
      .update({ is_active: false, deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null);
    if (error)
      throw new Error(`ShiftMembershipRepository.delete: ${error.message}`);
  }

  async findById(
    id: string,
    companyId: string,
  ): Promise<ShiftMembership | null> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error)
      throw new Error(`ShiftMembershipRepository.findById: ${error.message}`);
    return data ? ShiftMembership.fromPersistence(data as never) : null;
  }

  async findAllByCompany(
    companyId: string,
    filter?: ShiftMembershipFilter,
  ): Promise<ShiftMembership[]> {
    let q = this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null);
    if (filter?.employeeId) q = q.eq('employee_id', filter.employeeId);
    if (filter?.templateId) q = q.eq('template_id', filter.templateId);
    if (filter?.date) {
      q = q
        .lte('effective_from', filter.date)
        .or(`effective_until.is.null,effective_until.gte.${filter.date}`);
    }
    const { data, error } = await q;
    if (error)
      throw new Error(
        `ShiftMembershipRepository.findAllByCompany: ${error.message}`,
      );
    return (data ?? []).map((r) => ShiftMembership.fromPersistence(r as never));
  }

  async findActiveOnDate(
    companyId: string,
    dateISO: string,
  ): Promise<ShiftMembership[]> {
    const { data, error } = await this.supabase
      .from('shift_memberships')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .lte('effective_from', dateISO)
      .or(`effective_until.is.null,effective_until.gte.${dateISO}`);
    if (error)
      throw new Error(
        `ShiftMembershipRepository.findActiveOnDate: ${error.message}`,
      );
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
      .is('deleted_at', null)
      .lte('effective_from', toISO)
      .or(`effective_until.is.null,effective_until.gte.${fromISO}`);
    if (error)
      throw new Error(
        `ShiftMembershipRepository.findActiveInRange: ${error.message}`,
      );
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
      .eq('employee_id', employeeId)
      .is('deleted_at', null);
    if (error)
      throw new Error(
        `ShiftMembershipRepository.findByEmployee: ${error.message}`,
      );
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
      .eq('template_id', templateId)
      .is('deleted_at', null);
    if (error)
      throw new Error(
        `ShiftMembershipRepository.findByTemplate: ${error.message}`,
      );
    return (data ?? []).map((r) => ShiftMembership.fromPersistence(r as never));
  }
}
