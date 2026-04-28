import { ConflictException, Inject, Injectable } from '@nestjs/common';
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
    const skillId = skill.id as string;

    // 2. Lookup explícito del link (puede no existir, existir activo o
    //    existir soft-deleted). Hacemos esto en vez de un upsert porque el
    //    UNIQUE de (company_id, skill_id) ahora es parcial (WHERE
    //    deleted_at IS NULL) y Postgres no acepta ese índice como target
    //    de ON CONFLICT sin replicar el predicado, lo cual el cliente JS
    //    de Supabase no expone.
    const { data: existing, error: findErr } = await this.supabase
      .from('company_skills')
      .select('id, deleted_at')
      .eq('company_id', companyId)
      .eq('skill_id', skillId)
      .limit(1)
      .maybeSingle();
    if (findErr)
      throw new Error(`CompanySkillRepository.create(lookup): ${findErr.message}`);

    if (existing) {
      if (existing.deleted_at !== null) {
        // Revivir el link soft-deleted (silencioso, semánticamente "vuelve
        // al catálogo"; el manager lo había eliminado y ahora lo reagrega).
        const { data: revived, error: reviveErr } = await this.supabase
          .from('company_skills')
          .update({ is_active: true, deleted_at: null })
          .eq('id', existing.id as string)
          .select('id, company_id, skills ( id, name )')
          .single();
        if (reviveErr)
          throw new Error(`CompanySkillRepository.create(revive): ${reviveErr.message}`);
        return this.toDomain(revived as Record<string, unknown>);
      }
      // Ya existe activo: el manager intentó duplicar. Devolvemos 409 con
      // un errorCode que el frontend traduce. El dialog queda abierto y
      // muestra el mensaje en vez de cerrarse en silencio.
      throw new ConflictException({
        statusCode: 409,
        errorCode: 'SKILL_DUPLICATE',
        message: 'A skill with that name is already in the tenant catalog.',
      });
    }

    // 3. INSERT nuevo. Si dos requests concurrentes pasan por el lookup,
    //    el partial UNIQUE garantiza que solo una insertará — la otra
    //    cae al filter como SKILL_DUPLICATE → 409.
    const { data: inserted, error: insertErr } = await this.supabase
      .from('company_skills')
      .insert({ company_id: companyId, skill_id: skillId, is_active: true })
      .select('id, company_id, skills ( id, name )')
      .single();
    if (insertErr)
      throw new Error(`CompanySkillRepository.create(insert): ${insertErr.message}`);
    return this.toDomain(inserted as Record<string, unknown>);
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
