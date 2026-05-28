import type { ImportStaging } from './import-staging.aggregate';
import type { ImportStagingStatus } from './import-payload.types';

export const IMPORT_STAGING_REPOSITORY = 'IMPORT_STAGING_REPOSITORY';

export interface IImportStagingRepository {
  save(staging: ImportStaging): Promise<void>;

  findById(id: string, companyId: string): Promise<ImportStaging | null>;

  /**
   * Lookup sin filtro de tenant. Solo para platform_admin (debug).
   * Devuelve el row independientemente de la company.
   */
  findByIdCrossTenant(id: string): Promise<ImportStaging | null>;

  /**
   * Lista del tenant, ordenada por created_at desc. Filtro opcional por
   * status. Pensado para una sección "Mis imports" en la UI.
   */
  listByCompany(
    companyId: string,
    opts?: { status?: ImportStagingStatus[]; limit?: number },
  ): Promise<ImportStaging[]>;

  /**
   * Borra los rows con `status='pending_review'` y `expires_at < now`.
   * Llamado por el cleanup job daily.
   */
  deleteExpired(): Promise<number>;
}
