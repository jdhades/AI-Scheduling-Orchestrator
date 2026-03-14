import { ShiftTemplate } from '../aggregates/shift-template.aggregate';

export interface IShiftTemplateRepository {
    /**
     * Returns all active templates for the given company,
     * sorted by day_of_week ASC then start_time ASC.
     */
    findAllByCompany(companyId: string): Promise<ShiftTemplate[]>;

    /** Find a single template by id+companyId (tenant-safe). */
    findById(id: string, companyId: string): Promise<ShiftTemplate | null>;

    /** Upsert a template. */
    save(template: ShiftTemplate): Promise<void>;

    /** Hard-delete a template (instances already generated are preserved). */
    delete(id: string, companyId: string): Promise<void>;
}
