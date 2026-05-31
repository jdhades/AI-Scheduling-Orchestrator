import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import type { ImportPayload } from '../../domain/imports/import-payload.types';

/**
 * ImportReferenceResolver — resuelve referencias externas al payload.
 *
 * Caso típico: el owner sube solo `employees` con `departmentExternalId`
 * apuntando a departamentos que YA existen en BD (no incluidos en el
 * payload). Sin este servicio:
 *   - el validator emite warnings ruidosos "no está en payload"
 *   - el committer crea employees con department_id=null
 *
 * El resolver hace lookup en BD por:
 *   - employees: `external_id` (única tabla del subsistema con esa col)
 *   - departments / branches: `name` lowercase
 *   - roles: `skills.name` lowercase via company_skills
 *
 * Devuelve maps {externalId-del-payload → uuid-real} que el committer
 * usa para pre-poblar sus idMaps y el validator usa para clasificar
 * la severidad del warning (info si BD-resoluble, warn si neither).
 */
export interface ResolvedReferences {
  employees: Map<string, string>;
  departments: Map<string, string>;
  roles: Map<string, string>;
  branches: Map<string, string>;
}

@Injectable()
export class ImportReferenceResolverService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async resolveExternal(
    payload: ImportPayload,
    companyId: string,
  ): Promise<ResolvedReferences> {
    const inPayload = {
      employees: new Set(
        (payload.data.employees ?? []).map((e) => e.externalId),
      ),
      departments: new Set(
        (payload.data.departments ?? []).map((d) => d.externalId),
      ),
      roles: new Set((payload.data.roles ?? []).map((r) => r.externalId)),
      branches: new Set(
        (payload.data.locations ?? []).map((l) => l.externalId),
      ),
    };

    const referencedButMissing = {
      employees: new Set<string>(),
      departments: new Set<string>(),
      roles: new Set<string>(),
      branches: new Set<string>(),
    };

    for (const s of payload.data.shifts ?? []) {
      if (
        s.employeeExternalId &&
        !inPayload.employees.has(s.employeeExternalId)
      ) {
        referencedButMissing.employees.add(s.employeeExternalId);
      }
      if (
        s.departmentExternalId &&
        !inPayload.departments.has(s.departmentExternalId)
      ) {
        referencedButMissing.departments.add(s.departmentExternalId);
      }
      if (
        s.requiredRoleExternalId &&
        !inPayload.roles.has(s.requiredRoleExternalId)
      ) {
        referencedButMissing.roles.add(s.requiredRoleExternalId);
      }
      if (
        s.locationExternalId &&
        !inPayload.branches.has(s.locationExternalId)
      ) {
        referencedButMissing.branches.add(s.locationExternalId);
      }
    }
    for (const e of payload.data.employees ?? []) {
      if (
        e.departmentExternalId &&
        !inPayload.departments.has(e.departmentExternalId)
      ) {
        referencedButMissing.departments.add(e.departmentExternalId);
      }
      for (const rid of e.roleExternalIds ?? []) {
        if (!inPayload.roles.has(rid)) referencedButMissing.roles.add(rid);
      }
    }
    for (const d of payload.data.departments ?? []) {
      if (
        d.locationExternalId &&
        !inPayload.branches.has(d.locationExternalId)
      ) {
        referencedButMissing.branches.add(d.locationExternalId);
      }
    }
    for (const a of payload.data.availability ?? []) {
      if (
        a.employeeExternalId &&
        !inPayload.employees.has(a.employeeExternalId)
      ) {
        referencedButMissing.employees.add(a.employeeExternalId);
      }
    }
    for (const t of payload.data.timeOff ?? []) {
      if (
        t.employeeExternalId &&
        !inPayload.employees.has(t.employeeExternalId)
      ) {
        referencedButMissing.employees.add(t.employeeExternalId);
      }
    }

    const resolved: ResolvedReferences = {
      employees: new Map(),
      departments: new Map(),
      roles: new Map(),
      branches: new Map(),
    };

    if (referencedButMissing.employees.size > 0) {
      const ids = [...referencedButMissing.employees];
      const { data } = (await this.supabase
        .from('employees')
        .select('id, external_id')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .in('external_id', ids)) as unknown as {
        data: Array<{ id: string; external_id: string | null }> | null;
      };
      for (const r of data ?? []) {
        if (r.external_id) resolved.employees.set(r.external_id, r.id);
      }
    }

    if (referencedButMissing.departments.size > 0) {
      const { data } = (await this.supabase
        .from('departments')
        .select('id, name')
        .eq('company_id', companyId)
        .is('deleted_at', null)) as unknown as {
        data: Array<{ id: string; name: string | null }> | null;
      };
      const byNameLower = new Map<string, string>();
      for (const r of data ?? []) {
        if (r.name) byNameLower.set(r.name.toLowerCase(), r.id);
      }
      for (const ext of referencedButMissing.departments) {
        const m = byNameLower.get(ext.toLowerCase());
        if (m) resolved.departments.set(ext, m);
      }
    }

    if (referencedButMissing.roles.size > 0) {
      const { data } = (await this.supabase
        .from('company_skills')
        .select('id, skills(name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)) as unknown as {
        data: Array<{ id: string; skills: { name: string } | null }> | null;
      };
      const byNameLower = new Map<string, string>();
      for (const r of data ?? []) {
        const n = r.skills?.name;
        if (typeof n === 'string') byNameLower.set(n.toLowerCase(), r.id);
      }
      for (const ext of referencedButMissing.roles) {
        const m = byNameLower.get(ext.toLowerCase());
        if (m) resolved.roles.set(ext, m);
      }
    }

    if (referencedButMissing.branches.size > 0) {
      const { data } = (await this.supabase
        .from('branches')
        .select('id, name')
        .eq('company_id', companyId)
        .is('deleted_at', null)) as unknown as {
        data: Array<{ id: string; name: string | null }> | null;
      };
      const byNameLower = new Map<string, string>();
      for (const r of data ?? []) {
        if (r.name) byNameLower.set(r.name.toLowerCase(), r.id);
      }
      for (const ext of referencedButMissing.branches) {
        const m = byNameLower.get(ext.toLowerCase());
        if (m) resolved.branches.set(ext, m);
      }
    }

    return resolved;
  }
}
