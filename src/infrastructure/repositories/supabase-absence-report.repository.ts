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
      start_date: report.startDate,
      end_date: report.endDate,
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
      .is('deleted_at', null)
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
      .is('deleted_at', null)
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

  /**
   * Devuelve absences vigentes cuyo período intersecta con [fromDate, toDate].
   * Solapamiento: start_date <= toDate AND end_date >= fromDate.
   */
  async findActiveInRange(
    companyId: string,
    fromDate: string,
    toDate: string,
  ): Promise<AbsenceReport[]> {
    const { data, error } = await this.supabase
      .from('absence_reports')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .lte('start_date', toDate)
      .gte('end_date', fromDate);
    if (error)
      throw new Error(
        `AbsenceReportRepository.findActiveInRange: ${error.message}`,
      );
    return (data ?? []).map((r) => AbsenceReport.fromPersistence(r as never));
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('absence_reports')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null);
    if (error)
      throw new Error(`AbsenceReportRepository.softDelete: ${error.message}`);
  }
}
