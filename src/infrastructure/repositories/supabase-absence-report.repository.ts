import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AbsenceReport } from '../../domain/aggregates/absence-report.aggregate';
import type {
  IAbsenceReportRepository,
  AbsenceReportFilter,
} from '../../domain/repositories/absence-report.repository';

@Injectable()
export class SupabaseAbsenceReportRepository
  implements IAbsenceReportRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(report: AbsenceReport): Promise<void> {
    const { error } = await this.supabase.from('absence_reports').upsert({
      id: report.id,
      company_id: report.companyId,
      employee_id: report.employeeId,
      shift_assignment_id: report.assignmentId,
      reason: report.reason,
      is_urgent: report.isUrgent,
      reported_at: report.reportedAt.toISOString(),
    });
    if (error)
      throw new Error(`AbsenceReportRepository.save: ${error.message}`);
  }

  async findById(id: string, companyId: string): Promise<AbsenceReport | null> {
    const { data, error } = await this.supabase
      .from('absence_reports')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error)
      throw new Error(`AbsenceReportRepository.findById: ${error.message}`);
    return data ? AbsenceReport.fromPersistence(data as never) : null;
  }

  async findAllByCompany(
    companyId: string,
    filter?: AbsenceReportFilter,
  ): Promise<AbsenceReport[]> {
    let q = this.supabase
      .from('absence_reports')
      .select('*')
      .eq('company_id', companyId)
      .order('reported_at', { ascending: false });
    if (filter?.employeeId) q = q.eq('employee_id', filter.employeeId);
    if (filter?.isUrgent !== undefined) q = q.eq('is_urgent', filter.isUrgent);
    if (filter?.fromISO) q = q.gte('reported_at', filter.fromISO);
    const { data, error } = await q;
    if (error)
      throw new Error(
        `AbsenceReportRepository.findAllByCompany: ${error.message}`,
      );
    return (data ?? []).map((r) => AbsenceReport.fromPersistence(r as never));
  }
}
