import type {
  DayOffRequest,
  DayOffRequestStatus,
} from '../aggregates/day-off-request.aggregate';

export const DAY_OFF_REQUEST_REPOSITORY = 'DAY_OFF_REQUEST_REPOSITORY';

export interface DayOffRequestFilter {
  employeeId?: string;
  status?: DayOffRequestStatus | DayOffRequestStatus[];
  /** YYYY-MM-DD inclusive */
  fromDate?: string;
  toDate?: string;
}

export interface IDayOffRequestRepository {
  save(req: DayOffRequest): Promise<void>;
  findById(id: string, companyId: string): Promise<DayOffRequest | null>;
  findAllByCompany(
    companyId: string,
    filter?: DayOffRequestFilter,
  ): Promise<DayOffRequest[]>;
}
