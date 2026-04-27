import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CompanyPolicy,
  type CompanyPolicyProps,
} from '../../domain/aggregates/company-policy.aggregate';
import type { ICompanyPolicyRepository } from '../../domain/repositories/company-policy.repository';
import {
  PolicySeverity,
  type PolicySeverityValue,
} from '../../domain/value-objects/policy-severity.vo';

interface CompanyPolicyRow {
  id: string;
  company_id: string;
  text: string;
  severity: PolicySeverityValue;
  params: Record<string, unknown> | null;
  interpreter_id: string | null;
  is_active: boolean;
  effective_from: string;
  created_by: string | null;
  created_at: string;
  deleted_at: string | null;
}

/**
 * SupabaseCompanyPolicyRepository
 *
 * Persiste CompanyPolicy en `company_policies`. Soft-delete vía
 * `deleted_at`; el partial UNIQUE de la tabla garantiza una policy activa
 * por (company, interpreter). Las queries siempre filtran
 * `deleted_at IS NULL`.
 */
@Injectable()
export class SupabaseCompanyPolicyRepository
  implements ICompanyPolicyRepository
{
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(policy: CompanyPolicy): Promise<void> {
    const snap = policy.toSnapshot();
    const { error } = await this.supabase.from('company_policies').upsert({
      id: snap.id,
      company_id: snap.companyId,
      text: snap.text,
      severity: snap.severity.getValue(),
      params: snap.params,
      interpreter_id: snap.interpreterId,
      is_active: snap.isActive,
      effective_from: snap.effectiveFrom,
      created_by: snap.createdBy,
      created_at: snap.createdAt.toISOString(),
    });
    if (error) {
      throw new Error(`CompanyPolicyRepository.save: ${error.message}`);
    }
  }

  async delete(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('company_policies')
      .update({ is_active: false, deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null);
    if (error) {
      throw new Error(`CompanyPolicyRepository.delete: ${error.message}`);
    }
  }

  async findById(
    id: string,
    companyId: string,
  ): Promise<CompanyPolicy | null> {
    const { data, error } = await this.supabase
      .from('company_policies')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      throw new Error(`CompanyPolicyRepository.findById: ${error.message}`);
    }
    return data ? this.toDomain(data as CompanyPolicyRow) : null;
  }

  async findAllByCompany(companyId: string): Promise<CompanyPolicy[]> {
    const { data, error } = await this.supabase
      .from('company_policies')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(
        `CompanyPolicyRepository.findAllByCompany: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.toDomain(r as CompanyPolicyRow));
  }

  async findAllActiveByCompany(companyId: string): Promise<CompanyPolicy[]> {
    const { data, error } = await this.supabase
      .from('company_policies')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(
        `CompanyPolicyRepository.findAllActiveByCompany: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => this.toDomain(r as CompanyPolicyRow));
  }

  private toDomain(row: CompanyPolicyRow): CompanyPolicy {
    const props: CompanyPolicyProps = {
      id: row.id,
      companyId: row.company_id,
      text: row.text,
      severity: PolicySeverity.create(row.severity),
      params: row.params ?? {},
      interpreterId: row.interpreter_id,
      isActive: row.is_active,
      effectiveFrom: row.effective_from,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
    };
    return CompanyPolicy.fromPersistence(props);
  }
}
