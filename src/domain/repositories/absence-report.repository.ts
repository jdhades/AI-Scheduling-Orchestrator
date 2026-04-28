import type { AbsenceReport } from '../aggregates/absence-report.aggregate';

export const ABSENCE_REPORT_REPOSITORY = 'ABSENCE_REPORT_REPOSITORY';

export interface AbsenceReportFilter {
  employeeId?: string;
  isUrgent?: boolean;
  /** "YYYY-MM-DD" — devuelve solo reports con reported_at >= fromISO */
  fromISO?: string;
}

export interface IAbsenceReportRepository {
  save(report: AbsenceReport): Promise<void>;
  findById(id: string, companyId: string): Promise<AbsenceReport | null>;
  findAllByCompany(
    companyId: string,
    filter?: AbsenceReportFilter,
  ): Promise<AbsenceReport[]>;
}
