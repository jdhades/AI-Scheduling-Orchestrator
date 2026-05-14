import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  Matches,
} from 'class-validator';
import { randomBytes } from 'crypto';
import { Throttle } from '@nestjs/throttler';
import { SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Roles } from '../../infrastructure/auth/decorators/roles.decorator';
import { Public } from '../../infrastructure/auth/decorators/public.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

interface MeResponse {
  user: { id: string | null; email: string | null };
  employee: {
    id: string | null;
    name: string | null;
    role: 'owner' | 'manager' | 'employee' | null;
    departmentId: string | null;
  };
  company: {
    id: string;
    name: string | null;
    /** ISO timestamp cuando el owner completó el wizard de onboarding;
     * null mientras no esté completado. El frontend redirige a
     * /onboarding cuando owner + onboardedAt=null. */
    onboardedAt: string | null;
    /** 'trialing' | 'active' | 'past_due' | 'canceled'. El banner del
     * frontend lee esto para mostrar "Trial ends in N days" o equivalente. */
    subscriptionStatus: 'trialing' | 'active' | 'past_due' | 'canceled';
    /** ISO timestamp cuando el trial vence. Solo relevante si
     * subscriptionStatus='trialing'. */
    trialEndsAt: string | null;
  };
  permissions: string[];
  /** true si el caller está en `platform_admins`. El frontend usa esto
   * para mostrar el link a /admin y para evitar fetchs innecesarios. */
  isPlatformAdmin: boolean;
  /** Lista de capabilities efectivas del caller — unión de
   * company_role_capabilities[role] + employee_capabilities (overrides).
   * El frontend la usa para gatear UI (ocultar Settings si no tiene
   * settings:manage, etc.). Backend igualmente valida en cada endpoint
   * via @Requires + CapabilityGuard. */
  capabilities: string[];
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

export class UpdateMeDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name!: string;
}

export class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  // ≥1 dígito + ≥1 símbolo. Largo mínimo ya cubierto por MinLength.
  // Definimos esto acá y en el frontend para evitar round-trips.
  @Matches(/(?=.*\d)(?=.*[^A-Za-z0-9])/, {
    message: 'password must contain at least one digit and one symbol',
  })
  password!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name!: string;
}

export class CreateInvitationDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phoneNumber?: string;

  @IsIn(['manager', 'employee'])
  role!: 'owner' | 'manager' | 'employee';

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

interface InvitationRow {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  role: 'owner' | 'manager' | 'employee';
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
    // Anon client para signup público — respeta el flow nativo
    // (rate-limit Supabase + email confirmation si está habilitada).
    @Inject('SUPABASE_ANON_CLIENT')
    private readonly supabaseAnon: SupabaseClient,
  ) {}

  /**
   * POST /auth/signup — público. Crea un user en Supabase Auth con
   * metadata `signup_intent: 'self_signup'`. El trigger
   * `auth.handle_new_user` detecta el intent y crea atómicamente la
   * `companies` + `employees` (rol owner) + `onboarding_drafts` inicial.
   *
   * Rate limit aggressive (5/min/IP) — signup es endpoint sensible.
   * Supabase Auth tiene su propio rate-limit como segunda barrera.
   *
   * Si Supabase tiene `email_confirm` ON, la respuesta llega sin session
   * (`requiresEmailConfirm: true`). El frontend muestra "Revisá tu mail"
   * y espera al click del link de verificación, que abre el browser con
   * sesión activa y el wizard de onboarding listo.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('signup')
  async signup(
    @Body() body: SignupDto,
  ): Promise<{
    userId: string | null;
    requiresEmailConfirm: boolean;
  }> {
    const { data, error } = await this.supabaseAnon.auth.signUp({
      email: body.email,
      password: body.password,
      options: {
        data: {
          name: body.name,
          signup_intent: 'self_signup',
        },
      },
    });

    if (error) {
      // Mapping fino: email duplicado → 409, resto → 400.
      // Supabase usa 'user_already_exists' (nuevo) o el legacy 422.
      if (
        error.status === 422 ||
        error.code === 'user_already_exists' ||
        /already (registered|in use)/i.test(error.message)
      ) {
        throw new ConflictException('Email already in use');
      }
      throw new BadRequestException(error.message);
    }

    return {
      userId: data.user?.id ?? null,
      // Sin session = email confirmation está activa, el user debe
      // verificar antes de loguear.
      requiresEmailConfirm: data.session === null,
    };
  }

  @Get('me')
  @AllowExpiredTrial()
  async me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    if (!user || !user.companyId) {
      throw new NotFoundException('No authenticated context');
    }

    const companyP = this.supabase
      .from('companies')
      .select('id, name, onboarded_at, subscription_status, trial_ends_at')
      .eq('id', user.companyId)
      .maybeSingle();
    const employeeP = user.employeeId
      ? this.supabase
          .from('employees')
          .select('id, name, role, department_id, auth_user_id')
          .eq('id', user.employeeId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });
    const platformAdminP = user.userId
      ? this.supabase
          .from('platform_admins')
          .select('id')
          .eq('auth_user_id', user.userId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });
    // Role-level capabilities del user en esta company
    const roleCapsP = user.role
      ? this.supabase
          .from('company_role_capabilities')
          .select('capability')
          .eq('company_id', user.companyId)
          .eq('role', user.role)
      : Promise.resolve({ data: [], error: null });
    // User-level overrides (extras)
    const overridesP = user.employeeId
      ? this.supabase
          .from('employee_capabilities')
          .select('capability')
          .eq('employee_id', user.employeeId)
      : Promise.resolve({ data: [], error: null });

    const [companyRes, employeeRes, platformAdminRes, roleCapsRes, overridesRes] =
      await Promise.all([
        companyP,
        employeeP,
        platformAdminP,
        roleCapsP,
        overridesP,
      ]);
    const company = companyRes.data;
    const employee = employeeRes.data;
    const isPlatformAdmin = !!platformAdminRes.data;
    const capabilities = Array.from(
      new Set([
        ...((roleCapsRes.data ?? []).map(
          (r: { capability: string }) => r.capability,
        ) as string[]),
        ...((overridesRes.data ?? []).map(
          (r: { capability: string }) => r.capability,
        ) as string[]),
      ]),
    );

    let email: string | null = null;
    if (user.userId) {
      const { data } = await this.supabase.auth.admin.getUserById(user.userId);
      email = data.user?.email ?? null;
    }

    const role = user.role ?? employee?.role ?? null;
    // Owner hereda los permisos de manager (lo decidimos en el sprint de
    // self-signup). Lo único owner-exclusivo viene cuando se agreguen
    // capabilities específicas (Settings, promote, etc.).
    const permissions =
      role === 'owner' || role === 'manager'
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
      company: {
        id: user.companyId,
        name: company?.name ?? null,
        onboardedAt: company?.onboarded_at ?? null,
        subscriptionStatus:
          (company?.subscription_status as MeResponse['company']['subscriptionStatus']) ??
          'trialing',
        trialEndsAt: company?.trial_ends_at ?? null,
      },
      permissions,
      isPlatformAdmin,
      capabilities,
    };
  }

  /**
   * PATCH /auth/me — self-service edit del propio employee. Hoy solo
   * `name`. Email + password los maneja el cliente directo contra
   * Supabase Auth (updateUser) porque ahí pasa el flow de verificación
   * y re-auth de Supabase nativo.
   *
   * @AllowExpiredTrial — el user con trial expirado igual debe poder
   * editar su perfil (caso típico: cambiar nombre antes de pagar).
   */
  @Patch('me')
  @AllowExpiredTrial()
  @HttpCode(HttpStatus.OK)
  async updateMe(
    @CurrentUser() user: AuthContext,
    @Body() body: UpdateMeDto,
  ): Promise<{ id: string; name: string }> {
    if (!user?.employeeId) {
      throw new ForbiddenException(
        'No employee linked to this auth user — cannot edit profile',
      );
    }
    const { data, error } = await this.supabase
      .from('employees')
      .update({ name: body.name })
      .eq('id', user.employeeId)
      .select('id, name')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Employee not found');
    return { id: data.id as string, name: data.name as string };
  }

  /**
   * GET /auth/invitations — pending del tenant del caller.
   * Solo manager — el employee no debería ver el roster de invitados.
   */
  @Get('invitations')
  @Roles('owner', 'manager')
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
  @Roles('owner', 'manager')
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
  @Roles('owner', 'manager')
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
    role: 'owner' | 'manager' | 'employee';
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
    role: r.role as 'owner' | 'manager' | 'employee',
    departmentId: (r.department_id as string | null) ?? null,
    token: r.token as string,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
    consumedAt: (r.consumed_at as string | null) ?? null,
  });
}
