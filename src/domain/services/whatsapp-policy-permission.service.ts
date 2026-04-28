import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * WhatsappPolicyPermissionService
 *
 * Verifica si un empleado puede crear policies/rules vía WhatsApp,
 * según la lista de roles autorizados configurada por tenant en
 * companies.whatsapp_policy_creator_roles. Por default, solo 'manager'.
 *
 * El admin del tenant puede ampliar/cambiar la lista con un UPDATE
 * directo (UI de configuración queda como follow-up).
 */
@Injectable()
export class WhatsappPolicyPermissionService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /**
   * @returns true si el role del empleado está en la lista de
   *   whatsapp_policy_creator_roles del tenant.
   */
  async canCreatePolicy(input: {
    employeeRole: string;
    companyId: string;
  }): Promise<boolean> {
    const allowed = await this.getAllowedRoles(input.companyId);
    return allowed.includes(input.employeeRole);
  }

  /** Devuelve la lista de roles autorizados. Si la columna está vacía o
   *  el tenant no existe, cae al default conservador ['manager']. */
  async getAllowedRoles(companyId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('companies')
      .select('whatsapp_policy_creator_roles')
      .eq('id', companyId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `WhatsappPolicyPermissionService.getAllowedRoles: ${error.message}`,
      );
    }
    if (!data) {
      // Tenant no encontrado — fail closed por seguridad.
      return [];
    }
    const roles = (data as { whatsapp_policy_creator_roles?: string[] })
      .whatsapp_policy_creator_roles;
    if (!Array.isArray(roles) || roles.length === 0) {
      return ['manager'];
    }
    return roles;
  }
}
