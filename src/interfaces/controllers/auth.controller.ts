import {
  Controller,
  Get,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

interface MeResponse {
  user: { id: string | null; email: string | null };
  employee: {
    id: string | null;
    name: string | null;
    role: 'manager' | 'employee' | null;
    departmentId: string | null;
  };
  company: { id: string; name: string | null };
  /**
   * Lista de permisos derivados del rol — el frontend la usa para
   * mostrar/ocultar secciones. Sin claim explícito en BD (TODO PR
   * futuro: tabla permissions configurable por tenant); de momento
   * mapping fijo manager vs employee.
   */
  permissions: string[];
}

const MANAGER_PERMISSIONS = [
  'schedule:generate',
  'schedule:edit',
  'employee:manage',
  'template:manage',
  'rule:manage',
  'policy:manage',
  'approval:decide',
  'insights:view',
  'invitations:manage',
];

const EMPLOYEE_PERMISSIONS = [
  'schedule:view-self',
  'request:create',
  'request:view-self',
];

/**
 * AuthController
 *
 *   GET /auth/me — devuelve el perfil del caller (user + employee +
 *                  company + permisos derivados del rol). Frontend lo
 *                  llama al boot para hidratar el `AuthContext`.
 *
 * Endpoints futuros (PR 7): /auth/invitations CRUD.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    if (!user || !user.companyId) {
      throw new NotFoundException('No authenticated context');
    }

    // Lookup paralelo de company (siempre) + employee (si está linked).
    const companyP = this.supabase
      .from('companies')
      .select('id, name')
      .eq('id', user.companyId)
      .maybeSingle();
    const employeeP = user.employeeId
      ? this.supabase
          .from('employees')
          .select('id, name, role, department_id, auth_user_id')
          .eq('id', user.employeeId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });

    const [companyRes, employeeRes] = await Promise.all([companyP, employeeP]);

    const company = companyRes.data;
    const employee = employeeRes.data;

    // Email del auth.users — opcional, solo cuando hay user_id.
    let email: string | null = null;
    if (user.userId) {
      const { data } = await this.supabase.auth.admin.getUserById(user.userId);
      email = data.user?.email ?? null;
    }

    const role = user.role ?? employee?.role ?? null;
    const permissions =
      role === 'manager'
        ? MANAGER_PERMISSIONS
        : role === 'employee'
          ? EMPLOYEE_PERMISSIONS
          : [];

    return {
      user: { id: user.userId, email },
      employee: {
        id: employee?.id ?? null,
        name: employee?.name ?? null,
        role,
        departmentId: employee?.department_id ?? user.departmentId ?? null,
      },
      company: { id: user.companyId, name: company?.name ?? null },
      permissions,
    };
  }
}
