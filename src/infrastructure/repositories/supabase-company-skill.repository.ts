import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ICompanySkillRepository } from '../../domain/repositories/company-skill.repository';
import { CompanySkill } from '../../domain/aggregates/company-skill.aggregate';

/**
 * SupabaseCompanySkillRepository
 *
 * Mapea el join `skills` ⟵ `company_skills` y lo presenta como una entidad
 * compuesta. Los campos del aggregate que no están en DB
 * (`level`, `requiredExperienceMonths`, `certificationExpiration`) se
 * rellenan con defaults y NO se persisten — son metadata futura.
 */
@Injectable()
export class SupabaseCompanySkillRepository implements ICompanySkillRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async findAllByCompany(companyId: string): Promise<CompanySkill[]> {
    const { data, error } = await this.supabase
      .from('company_skills')
      .select('id, company_id, is_active, skills ( id, name )')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .is('deleted_at', null);
    if (error)
      throw new Error(`CompanySkillRepository.findAllByCompany: ${error.message}`);
    return (data ?? []).map((row) => this.toDomain(row as Record<string, unknown>));
  }

  async findById(id: string, companyId: string): Promise<CompanySkill | null> {
    const { data, error } = await this.supabase
      .from('company_skills')
      .select('id, company_id, is_active, skills ( id, name )')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error)
      throw new Error(`CompanySkillRepository.findById: ${error.message}`);
    return data ? this.toDomain(data as Record<string, unknown>) : null;
  }

  async create(companyId: string, name: string): Promise<CompanySkill> {
    const normalized = name.trim();
    if (!normalized) throw new Error('skill name cannot be empty');

    // 1. Upsert en catálogo global.
    const { data: skillRows, error: upsertErr } = await this.supabase
      .from('skills')
      .upsert({ name: normalized }, { onConflict: 'name' })
      .select('id, name')
      .limit(1);
    if (upsertErr)
      throw new Error(`CompanySkillRepository.create(catalog): ${upsertErr.message}`);
    const skill = (skillRows ?? [])[0];
    if (!skill) throw new Error('Failed to upsert skill in catalog');

    // 2. Intentar insert del link; si ya existe activo lo traemos.
    const { data: linkRows, error: linkErr } = await this.supabase
      .from('company_skills')
      .upsert(
        { company_id: companyId, skill_id: skill.id as string, is_active: true, deleted_at: null },
        { onConflict: 'company_id,skill_id' },
      )
      .select('id, company_id, skills ( id, name )')
      .limit(1);
    if (linkErr)
      throw new Error(`CompanySkillRepository.create(link): ${linkErr.message}`);
    const link = (linkRows ?? [])[0];
    if (!link) throw new Error('Failed to upsert company_skill link');

    return this.toDomain(link as Record<string, unknown>);
  }

  async delete(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('company_skills')
      .update({ is_active: false, deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null);
    if (error)
      throw new Error(`CompanySkillRepository.delete: ${error.message}`);
  }

  private toDomain(row: Record<string, unknown>): CompanySkill {
    const skill = (row.skills ?? {}) as Record<string, unknown>;
    return CompanySkill.fromPersistence({
      id: row.id as string,
      companyId: row.company_id as string,
      name: (skill.name as string) ?? '',
      level: 'junior', // no persistido; default safe
      requiredExperienceMonths: 0,
      certificationExpiration: null,
    });
  }
}
