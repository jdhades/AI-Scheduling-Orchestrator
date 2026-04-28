import type { CompanyPolicy } from '../aggregates/company-policy.aggregate';

export const COMPANY_POLICY_REPOSITORY = Symbol('COMPANY_POLICY_REPOSITORY');

/**
 * ICompanyPolicyRepository — port de dominio.
 *
 * Persistencia de políticas tenant-wide. La implementación de
 * infraestructura (Supabase) vive en otro layer. El solver del scheduler
 * llama a `findAllActiveByCompany` al inicio de cada generación para
 * cargar el stack de constraints aplicables.
 */
export interface ICompanyPolicyRepository {
  /** Guarda o actualiza una policy (upsert por id). */
  save(policy: CompanyPolicy): Promise<void>;

  /** Soft delete (is_active=false + deleted_at=NOW). */
  delete(id: string, companyId: string): Promise<void>;

  /** Devuelve null si no existe o está soft-deleted. */
  findById(id: string, companyId: string): Promise<CompanyPolicy | null>;

  /** Todas las policies del tenant, sin filtrar por isActive. */
  findAllByCompany(companyId: string): Promise<CompanyPolicy[]>;

  /**
   * Solo las policies activas. El solver usa esta para armar el stack de
   * constraints.
   */
  findAllActiveByCompany(companyId: string): Promise<CompanyPolicy[]>;
}
