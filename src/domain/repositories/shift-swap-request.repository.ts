import type {
  ShiftSwapRequest,
  ShiftSwapRequestStatus,
} from '../aggregates/shift-swap-request.aggregate';

export const SHIFT_SWAP_REQUEST_REPOSITORY = 'SHIFT_SWAP_REQUEST_REPOSITORY';

export interface ShiftSwapRequestFilter {
  requesterId?: string;
  targetId?: string;
  status?: ShiftSwapRequestStatus | ShiftSwapRequestStatus[];
}

export interface IShiftSwapRequestRepository {
  save(req: ShiftSwapRequest): Promise<void>;
  findById(id: string, companyId: string): Promise<ShiftSwapRequest | null>;
  findAllByCompany(
    companyId: string,
    filter?: ShiftSwapRequestFilter,
  ): Promise<ShiftSwapRequest[]>;
}
