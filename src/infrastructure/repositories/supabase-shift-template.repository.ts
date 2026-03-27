import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import { ShiftTemplate } from '../../domain/aggregates/shift-template.aggregate';
import { DemandWeight } from '../../domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../domain/value-objects/undesirable-weight.vo';
import { TenantContext } from '../tenant/tenant.context';

@Injectable()
export class SupabaseShiftTemplateRepository implements IShiftTemplateRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async findAllByCompany(companyId: string): Promise<ShiftTemplate[]> {
    const { data, error } = await this.supabase
      .from('shift_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('day_of_week', { ascending: true })
      .order('start_time', { ascending: true });

    if (error)
      throw new Error(
        `ShiftTemplateRepository.findAllByCompany failed: ${error.message}`,
      );
    return (data ?? []).map((r) => this.toDomain(r));
  }

  async findById(id: string, companyId: string): Promise<ShiftTemplate | null> {
    const { data, error } = await this.supabase
      .from('shift_templates')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single();

    if (error || !data) return null;
    return this.toDomain(data);
  }

  async save(template: ShiftTemplate): Promise<void> {
    const { error } = await this.supabase.from('shift_templates').upsert({
      id: template.id,
      company_id: template.companyId,
      name: template.name,
      day_of_week: template.dayOfWeek,
      start_time: template.startTime,
      end_time: template.endTime,
      required_skill_id: template.requiredSkillId,
      demand_score: template.demandScore.value,
      undesirable_weight: template.undesirableWeight.value,
      is_active: template.isActive,
    });
    if (error)
      throw new Error(`ShiftTemplateRepository.save failed: ${error.message}`);
  }

  async delete(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('shift_templates')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error)
      throw new Error(
        `ShiftTemplateRepository.delete failed: ${error.message}`,
      );
  }

  private toDomain(row: Record<string, any>): ShiftTemplate {
    return ShiftTemplate.fromPersistence({
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      dayOfWeek: row.day_of_week,
      startTime: row.start_time, // stored as TIME string "HH:MM:SS"
      endTime: row.end_time,
      requiredSkillId: row.required_skill_id ?? null,
      requiredSkillLevel: 'junior', // templates define role, not level — always cast to junior for now
      requiredExperienceMonths: 0,
      demandScore: DemandWeight.create(row.demand_score),
      undesirableWeight: UndesirableWeight.create(row.undesirable_weight),
      isActive: row.is_active,
    });
  }
}
