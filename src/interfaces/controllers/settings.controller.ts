import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Put,
} from '@nestjs/common';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  CAPABILITIES,
  type Capability,
} from '../../domain/capabilities/catalog';
import { CompanyPreferencesService } from '../../application/services/company-preferences.service';
import {
  FAIRNESS_HISTORY_REPOSITORY,
  type IFairnessHistoryRepository,
} from '../../domain/repositories/fairness-history.repository';

/**
 * SettingsController — admin de RBAC para el owner.
 *
 *   GET  /settings/capabilities             → catalog + current role config
 *   PUT  /settings/capabilities/:role       → replace caps de un rol
 *
 *   GET  /settings/managers                 → list managers + scopes + grants
 *   PUT  /settings/managers/:id/scopes      → replace manager_scopes
 *   PUT  /settings/managers/:id/capabilities → replace employee_capabilities
 *
 * Class-level @Requires('settings:manage') — gated solo a quien tiene
 * esa capability (default: owner; manager con grant individual también).
 * @AllowExpiredTrial — el owner debe poder reorganizar caps incluso
 * con trial expirado.
 */
export class ReplaceRoleCapabilitiesDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  capabilities!: string[];
}

class ScopeAssignmentInput {
  @IsIn(['branch', 'department'])
  type!: 'branch' | 'department';

  @IsUUID()
  id!: string;
}

export class ReplaceScopesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeAssignmentInput)
  scopes!: ScopeAssignmentInput[];
}

export class ReplaceCapabilitiesDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  capabilities!: string[];
}

interface CapabilityInfo {
  key: Capability;
  description: string;
  defaultRoles: readonly string[];
  scoped: boolean;
}

interface CapabilitiesResponse {
  catalog: CapabilityInfo[];
  roleConfig: Record<'owner' | 'manager' | 'employee', string[]>;
}

interface ManagerSummary {
  id: string;
  name: string | null;
  role: 'owner' | 'manager' | 'employee';
  scopes: Array<{ type: 'branch' | 'department'; id: string; name: string }>;
  extraCapabilities: string[];
}

@Controller('settings')
@Requires('settings:manage')
@AllowExpiredTrial()
export class SettingsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly companyPreferences: CompanyPreferencesService,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepo: IFairnessHistoryRepository,
  ) {}

  // ─── Capabilities (role-level) ──────────────────────────────────────

  @Get('capabilities')
  async getCapabilities(
    @CurrentCompany() companyId: string,
  ): Promise<CapabilitiesResponse> {
    const { data, error } = await this.supabase
      .from('company_role_capabilities')
      .select('role, capability')
      .eq('company_id', companyId);
    if (error) throw new BadRequestException(error.message);

    const roleConfig: CapabilitiesResponse['roleConfig'] = {
      owner: [],
      manager: [],
      employee: [],
    };
    for (const row of data ?? []) {
      const role = row.role as keyof typeof roleConfig;
      if (role in roleConfig) {
        roleConfig[role].push(row.capability as string);
      }
    }

    const catalog: CapabilityInfo[] = (
      Object.entries(CAPABILITIES) as [
        Capability,
        { description: string; defaultRoles: readonly string[] },
      ][]
    ).map(([key, def]) => ({
      key,
      description: def.description,
      defaultRoles: def.defaultRoles,
      scoped: this.isScoped(key),
    }));

    return { catalog, roleConfig };
  }

  @Put('capabilities/:role')
  @HttpCode(HttpStatus.OK)
  async replaceRoleCapabilities(
    @Param('role') role: 'owner' | 'manager' | 'employee',
    @CurrentCompany() companyId: string,
    @Body() body: ReplaceRoleCapabilitiesDto,
  ): Promise<{ role: string; capabilities: string[] }> {
    if (!['owner', 'manager', 'employee'].includes(role)) {
      throw new BadRequestException(`Invalid role: ${role}`);
    }
    this.assertCapabilitiesValid(body.capabilities);

    // Replace: delete then insert. Idempotente; safe si el set es igual.
    const { error: delErr } = await this.supabase
      .from('company_role_capabilities')
      .delete()
      .eq('company_id', companyId)
      .eq('role', role);
    if (delErr) throw new BadRequestException(delErr.message);

    if (body.capabilities.length > 0) {
      const rows = body.capabilities.map((c) => ({
        company_id: companyId,
        role,
        capability: c,
      }));
      const { error: insErr } = await this.supabase
        .from('company_role_capabilities')
        .insert(rows);
      if (insErr) throw new BadRequestException(insErr.message);
    }

    return { role, capabilities: body.capabilities };
  }

  // ─── Managers (scopes + per-user grants) ────────────────────────────

  @Get('managers')
  async listManagers(
    @CurrentCompany() companyId: string,
  ): Promise<ManagerSummary[]> {
    const { data: employees, error: empErr } = await this.supabase
      .from('employees')
      .select('id, name, role')
      .eq('company_id', companyId)
      .in('role', ['manager', 'owner'])
      .order('name', { ascending: true });
    if (empErr) throw new BadRequestException(empErr.message);

    const empIds = (employees ?? []).map((e) => e.id as string);
    if (empIds.length === 0) return [];

    // Fetch scopes
    const { data: scopes } = await this.supabase
      .from('manager_scopes')
      .select('employee_id, scope_type, scope_id')
      .in('employee_id', empIds);

    // Fetch per-user grants
    const { data: grants } = await this.supabase
      .from('employee_capabilities')
      .select('employee_id, capability')
      .in('employee_id', empIds);

    // Resolve scope_id → name (join with branches + departments)
    const branchIds = new Set<string>();
    const deptIds = new Set<string>();
    for (const s of scopes ?? []) {
      if (s.scope_type === 'branch') branchIds.add(s.scope_id as string);
      else if (s.scope_type === 'department') deptIds.add(s.scope_id as string);
    }

    const branchNames = new Map<string, string>();
    if (branchIds.size > 0) {
      const { data } = await this.supabase
        .from('branches')
        .select('id, name')
        .in('id', Array.from(branchIds));
      for (const b of data ?? []) branchNames.set(b.id, b.name);
    }
    const deptNames = new Map<string, string>();
    if (deptIds.size > 0) {
      const { data } = await this.supabase
        .from('departments')
        .select('id, name')
        .in('id', Array.from(deptIds));
      for (const d of data ?? []) deptNames.set(d.id, d.name);
    }

    return (employees ?? []).map((e) => {
      const empScopes = (scopes ?? []).filter((s) => s.employee_id === e.id);
      const empGrants = (grants ?? []).filter((g) => g.employee_id === e.id);
      return {
        id: e.id as string,
        name: (e.name as string | null) ?? null,
        role: e.role as ManagerSummary['role'],
        scopes: empScopes.map((s) => ({
          type: s.scope_type as 'branch' | 'department',
          id: s.scope_id as string,
          name:
            s.scope_type === 'branch'
              ? (branchNames.get(s.scope_id as string) ?? '(unknown branch)')
              : (deptNames.get(s.scope_id as string) ?? '(unknown department)'),
        })),
        extraCapabilities: empGrants.map((g) => g.capability as string),
      };
    });
  }

  @Put('managers/:id/scopes')
  @HttpCode(HttpStatus.OK)
  async replaceManagerScopes(
    @Param('id') employeeId: string,
    @CurrentCompany() companyId: string,
    @Body() body: ReplaceScopesDto,
  ): Promise<{ id: string; count: number }> {
    // Validar que el employee pertenece a la company.
    const { data: emp, error: eErr } = await this.supabase
      .from('employees')
      .select('id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (eErr) throw new BadRequestException(eErr.message);
    if (!emp) throw new NotFoundException('Employee not found in this tenant');

    // Validar que cada scope_id pertenece a esta company (cross-tenant guard).
    if (body.scopes.length > 0) {
      const branchIds = body.scopes.filter((s) => s.type === 'branch').map((s) => s.id);
      const deptIds = body.scopes.filter((s) => s.type === 'department').map((s) => s.id);

      if (branchIds.length > 0) {
        const { count } = await this.supabase
          .from('branches')
          .select('id', { count: 'exact', head: true })
          .in('id', branchIds)
          .eq('company_id', companyId);
        if ((count ?? 0) !== branchIds.length) {
          throw new BadRequestException(
            'One or more branch scopes do not belong to this tenant',
          );
        }
      }
      if (deptIds.length > 0) {
        const { count } = await this.supabase
          .from('departments')
          .select('id', { count: 'exact', head: true })
          .in('id', deptIds)
          .eq('company_id', companyId);
        if ((count ?? 0) !== deptIds.length) {
          throw new BadRequestException(
            'One or more department scopes do not belong to this tenant',
          );
        }
      }
    }

    // Replace.
    const { error: delErr } = await this.supabase
      .from('manager_scopes')
      .delete()
      .eq('employee_id', employeeId);
    if (delErr) throw new BadRequestException(delErr.message);

    if (body.scopes.length > 0) {
      const rows = body.scopes.map((s) => ({
        employee_id: employeeId,
        scope_type: s.type,
        scope_id: s.id,
      }));
      const { error: insErr } = await this.supabase
        .from('manager_scopes')
        .insert(rows);
      if (insErr) throw new BadRequestException(insErr.message);
    }

    return { id: employeeId, count: body.scopes.length };
  }

  @Put('managers/:id/capabilities')
  @HttpCode(HttpStatus.OK)
  async replaceManagerCapabilities(
    @Param('id') employeeId: string,
    @CurrentUser() user: AuthContext,
    @CurrentCompany() companyId: string,
    @Body() body: ReplaceCapabilitiesDto,
  ): Promise<{ id: string; capabilities: string[] }> {
    // Tenant guard
    const { data: emp, error: eErr } = await this.supabase
      .from('employees')
      .select('id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (eErr) throw new BadRequestException(eErr.message);
    if (!emp) throw new NotFoundException('Employee not found in this tenant');

    this.assertCapabilitiesValid(body.capabilities);

    // Replace
    const { error: delErr } = await this.supabase
      .from('employee_capabilities')
      .delete()
      .eq('employee_id', employeeId);
    if (delErr) throw new BadRequestException(delErr.message);

    if (body.capabilities.length > 0) {
      const rows = body.capabilities.map((c) => ({
        employee_id: employeeId,
        capability: c,
        granted_by: user.employeeId ?? null,
      }));
      const { error: insErr } = await this.supabase
        .from('employee_capabilities')
        .insert(rows);
      if (insErr) throw new BadRequestException(insErr.message);
    }

    return { id: employeeId, capabilities: body.capabilities };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private assertCapabilitiesValid(caps: string[]): void {
    const knownCaps = new Set(Object.keys(CAPABILITIES));
    const unknown = caps.filter((c) => !knownCaps.has(c));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown capabilities: ${unknown.join(', ')}`,
      );
    }
  }

  private isScoped(cap: Capability): boolean {
    // Import sin top-level por circular dep risk; inline check.
    const scoped = new Set<Capability>([
      'departments:write',
      'employees:write',
      'schedule:write',
      'swaps:approve',
      'absences:approve',
      'incidents:manage',
      'dayoffs:approve',
    ]);
    return scoped.has(cap);
  }

  // ─── Company settings (preferencias del tenant) ─────────────────────

  /**
   * PATCH /settings/company — actualiza preferencias del tenant.
   *
   * Por ahora solo `weekStartsOn`. Llamado desde la Settings page del
   * owner para cambiar el día de inicio de semana después del
   * onboarding. Afecta cómo el frontend computa "esta semana" y cómo
   * el solver agrupa fechas en futuras generaciones.
   */
  @Patch('company')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateCompanySettings(
    @CurrentCompany() companyId: string,
    @Body() body: UpdateCompanySettingsDto,
  ): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (body.weekStartsOn) updates.week_starts_on = body.weekStartsOn;
    if (Object.keys(updates).length === 0) return;

    // Comparar valor previo para saber si weekStartsOn realmente cambia.
    // Si cambia, debemos resetear fairness_history (las rows existentes
    // están keyed por el anchor viejo y el solver las mezclaría con las
    // nuevas, comparando semanas que no se corresponden).
    let weekStartsOnChanged = false;
    if (body.weekStartsOn) {
      const previous = await this.companyPreferences.getWeekStartsOn(companyId);
      weekStartsOnChanged = previous !== body.weekStartsOn;
    }

    const { error } = await this.supabase
      .from('companies')
      .update(updates)
      .eq('id', companyId);
    if (error) throw new BadRequestException(error.message);
    this.companyPreferences.invalidate(companyId);

    if (weekStartsOnChanged) {
      await this.fairnessRepo.deleteAllByCompany(companyId);
    }
  }
}

export class UpdateCompanySettingsDto {
  @IsIn(['sunday', 'monday'])
  weekStartsOn!: 'sunday' | 'monday';
}
