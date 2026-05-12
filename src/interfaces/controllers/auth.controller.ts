import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { randomBytes } from 'crypto';
import { Throttle } from '@nestjs/throttler';
import { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Roles } from '../../infrastructure/auth/decorators/roles.decorator';
import { Public } from '../../infrastructure/auth/decorators/public.decorator';
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

export class CreateInvitationDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phoneNumber?: string;

  @IsIn(['manager', 'employee'])
  role!: 'manager' | 'employee';

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

interface InvitationRow {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  role: 'manager' | 'employee';
  departmentId: string | null;
  token: string;
  expiresAt: string;
  createdAt: string;
  consumedAt: string | null;
}

/**
 * AuthController
 *
 *   GET    /auth/me                 → perfil del caller
 *   GET    /auth/invitations        → list pending (manager only)
 *   POST   /auth/invitations        → crear invitación (manager only)
 *   DELETE /auth/invitations/:id    → revocar (manager only)
 *   GET    /auth/invitations/by-token/:token → preview público (sin auth)
 *
 * El `acceptInvitation` real lo hace Supabase Auth al consumir el link
 * (signup con `?token=`). El trigger `auth.handle_new_user` se encarga
 * de crear el employee linkeado y marcar la invitación consumed.
 */
@Controller('auth')
export class AuthController {
  /** TTL default de invitaciones — 7 días para email-based. */
  private static readonly DEFAULT_TTL_HOURS = 24 * 7;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    if (!user || !user.companyId) {
      throw new NotFoundException('No authenticated context');
    }

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

  /**
   * GET /auth/invitations — pending del tenant del caller.
   * Solo manager — el employee no debería ver el roster de invitados.
   */
  @Get('invitations')
  @Roles('manager')
  async listInvitations(
    @CurrentCompany() companyId: string,
  ): Promise<InvitationRow[]> {
    const { data, error } = await this.supabase
      .from('auth_invitations')
      .select(
        'id, email, phone_number, role, department_id, token, expires_at, created_at, consumed_at',
      )
      .eq('company_id', companyId)
      .is('consumed_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(this.toInvitationRow);
  }

  /**
   * POST /auth/invitations — crea fila con token random + TTL.
   * Frontend manda email/phone + role + dept; el link/OTP se envía
   * separado (futuro: Supabase Auth sendInviteEmail / SMS). De momento
   * el manager copy-pastea el link manualmente.
   */
  @Post('invitations')
  @Roles('manager')
  @HttpCode(HttpStatus.CREATED)
  async createInvitation(
    @CurrentUser() user: AuthContext,
    @CurrentCompany() companyId: string,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationRow> {
    if (!dto.email && !dto.phoneNumber) {
      throw new BadRequestException('Either email or phoneNumber is required');
    }
    // En DEV bypass user.employeeId puede ser null — guardamos invited_by=null.
    // Cuando PR 9 elimine el bypass, esto siempre tendrá valor.
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + AuthController.DEFAULT_TTL_HOURS * 60 * 60 * 1000,
    );
    const { data, error } = await this.supabase
      .from('auth_invitations')
      .insert({
        company_id: companyId,
        invited_by: user.employeeId ?? null,
        email: dto.email ?? null,
        phone_number: dto.phoneNumber ?? null,
        role: dto.role,
        department_id: dto.departmentId ?? null,
        token,
        expires_at: expiresAt.toISOString(),
      })
      .select('*')
      .single();
    if (error) {
      // 23505 = unique violation. Significa que ya hay invitación pending
      // con ese token (race) o mismo email/phone duplicado al insertar.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('Invitation already exists');
      }
      throw new Error(error.message);
    }
    return this.toInvitationRow(data);
  }

  /**
   * DELETE /auth/invitations/:id — revocar pending. 404 si no es del
   * tenant del caller (no revelar existencia).
   */
  @Delete('invitations/:id')
  @Roles('manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteInvitation(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const { data, error } = await this.supabase
      .from('auth_invitations')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('consumed_at', null)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new NotFoundException('Invitation not found');
    }
  }

  /**
   * GET /auth/invitations/by-token/:token — preview público (sin auth).
   * El frontend lo llama desde /accept para mostrar "Te invitaron a
   * Demo Co como manager" antes del signup. NO devuelve el token de
   * la fila (paranoia — el caller ya lo tiene en el URL).
   */
  @Get('invitations/by-token/:token')
  @Public()
  // 20/min/IP — defiende contra brute-force scanning de tokens
  // (random 32 bytes = ~10^77 combos, igual queremos rate-limit
  // estricto en el path público que no requiere auth).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async previewInvitation(
    @Param('token') token: string,
  ): Promise<{
    email: string | null;
    phoneNumber: string | null;
    role: 'manager' | 'employee';
    companyName: string | null;
    expiresAt: string;
  }> {
    const { data, error } = await this.supabase
      .from('auth_invitations')
      .select(
        'email, phone_number, role, expires_at, consumed_at, company_id',
      )
      .eq('token', token)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data.consumed_at) {
      throw new NotFoundException('Invitation not found or already consumed');
    }
    if (new Date(data.expires_at) < new Date()) {
      throw new NotFoundException('Invitation expired');
    }
    const { data: company } = await this.supabase
      .from('companies')
      .select('name')
      .eq('id', data.company_id)
      .maybeSingle();
    return {
      email: data.email,
      phoneNumber: data.phone_number,
      role: data.role,
      companyName: company?.name ?? null,
      expiresAt: data.expires_at,
    };
  }

  private toInvitationRow = (
    r: Record<string, unknown>,
  ): InvitationRow => ({
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    phoneNumber: (r.phone_number as string | null) ?? null,
    role: r.role as 'manager' | 'employee',
    departmentId: (r.department_id as string | null) ?? null,
    token: r.token as string,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
    consumedAt: (r.consumed_at as string | null) ?? null,
  });
}
