import { ShiftTemplate } from '../aggregates/shift-template.aggregate';

export interface ShiftTemplatePatch {
  name?: string;
  dayOfWeek?: number | null;
  startTime?: string;
  endTime?: string;
  requiredSkillId?: string | null;
  demandScore?: number;
  undesirableWeight?: number;
  isActive?: boolean;
  requiredEmployees?: number | null;
}

export interface IShiftTemplateRepository {
  /**
   * Returns all active templates for the given company,
   * sorted by day_of_week ASC then start_time ASC.
   * Excludes rows with deleted_at != null.
   */
  findAllByCompany(companyId: string): Promise<ShiftTemplate[]>;

  /** Find a single template by id+companyId (tenant-safe). Excludes soft-deleted. */
  findById(id: string, companyId: string): Promise<ShiftTemplate | null>;

  /** Upsert a template. */
  save(template: ShiftTemplate): Promise<void>;

  /** Partial update on a subset of fields. */
  updatePartial(id: string, companyId: string, patch: ShiftTemplatePatch): Promise<void>;

  /** Soft delete: is_active=false + deleted_at=NOW(). Instances ya generadas quedan intactas. */
  delete(id: string, companyId: string): Promise<void>;
}
