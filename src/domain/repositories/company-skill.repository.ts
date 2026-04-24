import type { CompanySkill } from '../aggregates/company-skill.aggregate';

export const COMPANY_SKILL_REPOSITORY = 'COMPANY_SKILL_REPOSITORY';

/**
 * ICompanySkillRepository — port para gestión del catálogo de skills
 * de cada empresa. El modelo físico es un join:
 *
 *   skills          (catálogo global: name único)
 *   company_skills  (link tenant ↔ skill)
 *
 * Este repo abstrae el join: el caller trabaja con `{ id, name }` por
 * company; las operaciones que afectan a la tabla `skills` global (crear
 * un nombre nuevo) las resuelve la implementación.
 */
export interface ICompanySkillRepository {
  findAllByCompany(companyId: string): Promise<CompanySkill[]>;
  findById(id: string, companyId: string): Promise<CompanySkill | null>;

  /**
   * Crea el link company↔skill. Si `name` aún no existe en el catálogo
   * global, lo inserta primero.
   */
  create(companyId: string, name: string): Promise<CompanySkill>;

  /** Soft delete del link (is_active=false + deleted_at=NOW). */
  delete(id: string, companyId: string): Promise<void>;
}
