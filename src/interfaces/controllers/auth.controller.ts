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
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
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
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';
import { EmailService } from '../../infrastructure/notifications/email.service';

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
    /** Primer día de la semana laboral. Configurado en onboarding,
     * editable desde Settings. Default 'monday'. */
    weekStartsOn: 'sunday' | 'monday';
  };
  permissions: string[];
  /** true si el caller está en `platform_admins`. El frontend usa esto
   * para mostrar el link a /admin y para evitar fetchs innecesarios. */
  isPlatformAdmin: boolean;
  /** Sub-rol del platform_admin si aplica. null para non-admins. Los
   * 'super' pueden gestionar otros admins; los 'support' solo operan
   * el resto del panel. */
  platformRole: 'super' | 'support' | null;
  /** Lista de capabilities efectivas del caller — unión de
   * company_role_capabilities[role] + employee_capabilities (overrides).
   * El frontend la usa para gatear UI (ocultar Settings si no tiene
   * settings:manage, etc.). Backend igualmente valida en cada endpoint
   * via @Requires + CapabilityGuard. */
  capabilities: string[];
  /** Feature flags habilitados en el tenant. Lista de keys (sin payload)
   * — el frontend solo necesita saber si están on/off para gatear UI.
   * Ejemplos: 'help_ai_chat' habilita la pestaña de chat del HelpPanel.
   * Para platform_admins (sin company) viene como [] siempre. */
  tenantFeatures: string[];
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
  @IsUUID('loose')
  departmentId?: string;

  /**
   * Si se setea, vincula la invitación a un employee existente.
   * El trigger handle_new_user va a UPDATE ese row's auth_user_id en lugar
   * de INSERT uno nuevo. Usado desde EmployeesPage → "Send Invite".
   * Sin esto (path "ad-hoc" desde /team), el trigger crea employee nuevo.
   */
  @IsOptional()
  @IsUUID('loose')
  employeeId?: string;
}

export class AcceptInvitationDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password!: string;
}

/**
 * Eventos que el cliente puede registrar tras una acción de auth
 * exitosa. Restringido a eventos que el client *acaba de hacer* y que
 * el JWT válido respalda — login_fail / permission_denied / role_changed
 * NO entran acá (los maneja el server-side).
 */
type ClientAuditEvent =
  | 'login_success'
  | 'mfa_enrolled'
  | 'mfa_disabled'
  | 'password_reset'
  | 'session_invalidated';

export class CreateAuthAuditEventDto {
  @IsIn([
    'login_success',
    'mfa_enrolled',
    'mfa_disabled',
    'password_reset',
    'session_invalidated',
  ])
  event!: ClientAuditEvent;

  @IsOptional()
  metadata?: Record<string, unknown>;
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
    private readonly tenantFeatures: TenantFeatureService,
    private readonly emailService: EmailService,
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
  async signup(@Body() body: SignupDto): Promise<{
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
    if (!user || !user.userId) {
      throw new NotFoundException('No authenticated context');
    }

    // Platform admins no tienen company asociada (companyId=''). Sus
    // queries de company/employee/role-caps devuelven null/vacío y la
    // respuesta queda con isPlatformAdmin=true como discriminador.
    const hasCompany = !!user.companyId;
    const companyP = hasCompany
      ? this.supabase
          .from('companies')
          .select(
            'id, name, onboarded_at, subscription_status, trial_ends_at, week_starts_on',
          )
          .eq('id', user.companyId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });
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
          .select('id, role')
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

    // Features del tenant — los keys habilitados (no payload). Platform
    // admins no pertenecen a una company → lista vacía. El TenantFeatureService
    // ya cachea por companyId, así que el costo es 1 query indexada (o cache hit).
    const featuresP: Promise<Array<{ key: string; enabled: boolean }>> =
      this.tenantFeatures
        .listForCompany(user.companyId)
        .catch(() => [] as Array<{ key: string; enabled: boolean }>);

    const [
      companyRes,
      employeeRes,
      platformAdminRes,
      roleCapsRes,
      overridesRes,
      featuresList,
    ] = await Promise.all([
      companyP,
      employeeP,
      platformAdminP,
      roleCapsP,
      overridesP,
      featuresP,
    ]);
    const company = companyRes.data;
    const employee = employeeRes.data;
    const isPlatformAdmin = !!platformAdminRes.data;
    const platformRole =
      (platformAdminRes.data?.role as 'super' | 'support' | undefined) ?? null;
    const capabilities = Array.from(
      new Set([
        ...(roleCapsRes.data ?? []).map(
          (r: { capability: string }) => r.capability,
        ),
        ...(overridesRes.data ?? []).map(
          (r: { capability: string }) => r.capability,
        ),
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
        weekStartsOn:
          (company?.week_starts_on as 'sunday' | 'monday') ?? 'monday',
      },
      permissions,
      isPlatformAdmin,
      platformRole,
      capabilities,
      tenantFeatures: featuresList.filter((f) => f.enabled).map((f) => f.key),
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
   * POST /auth/invitations — crea fila con token random + TTL, manda mail.
   *
   * Tres modos:
   *   1) `email + employeeId` → link a employee existente (UPDATE en trigger).
   *      Usado desde EmployeesPage → "Send Invite".
   *   2) `email` solo → ad-hoc. El trigger crea employee nuevo al aceptar.
   *      Usado desde /team (back-compat) cuando se invita a alguien que
   *      todavía no está en la tabla.
   *   3) `phoneNumber` → idem ad-hoc pero por SMS (Twilio, futuro). Hoy
   *      el mail no se manda; el manager copia el link manual.
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

    // Si vino employeeId, validar que sea del mismo tenant + que el row
    // existe + que no esté ya linkeado a un auth_user.
    let inviterName = 'A manager';
    let companyName = 'Your company';
    if (dto.employeeId) {
      const { data: emp } = await this.supabase
        .from('employees')
        .select('id, name, company_id, auth_user_id, email')
        .eq('id', dto.employeeId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (!emp) {
        throw new BadRequestException(
          `Employee ${dto.employeeId} not found in this company`,
        );
      }
      if (emp.auth_user_id) {
        throw new ConflictException(
          'Employee already has an active account; revoke + re-invite if needed',
        );
      }
      // Si el row tenía email guardado y el caller mandó otro distinto, los
      // alineamos (el caller del UI es la fuente de verdad ahora).
      if (dto.email && emp.email && emp.email !== dto.email) {
        await this.supabase
          .from('employees')
          .update({ email: dto.email })
          .eq('id', emp.id);
      }
    }

    // Nombre del inviter + company para usar en el template del mail.
    if (user.employeeId) {
      const { data: me } = await this.supabase
        .from('employees')
        .select('name')
        .eq('id', user.employeeId)
        .maybeSingle();
      if (me?.name) inviterName = me.name as string;
    }
    const { data: co } = await this.supabase
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .maybeSingle();
    if (co?.name) companyName = co.name as string;

    // En DEV bypass user.employeeId puede ser null — guardamos
    // invited_by=null. En prod nunca pasa (bypass deshabilitado al
    // boot), así que invited_by siempre tendrá el employeeId del JWT.
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
        employee_id: dto.employeeId ?? null,
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

    // Mandar mail de invitación (si hay email). Si falla, el row queda
    // creado igual — el manager puede mandar el link manual via "Copy link".
    if (dto.email) {
      try {
        await this.emailService.sendInvitation({
          to: dto.email,
          token,
          companyName,
          inviterName,
          role: dto.role === 'owner' ? 'manager' : dto.role,
        });
      } catch (err) {
        // Log y seguimos — la invitación quedó válida en DB, el manager
        // puede copiar el link manual.

        console.warn(
          `Invitation row created but email send failed for ${dto.email}: ${(err as Error).message}`,
        );
      }
    }

    return this.toInvitationRow(data);
  }

  /**
   * POST /auth/invitations/:token/accept — flujo público de aceptación.
   *
   * El user llega via el link del mail (`/accept?token=...`). El frontend
   * pide name + password y postea acá. Usamos service_role.admin.createUser
   * con email_confirm=true para evitar el doble-mail de signup-confirm:
   * la invitación misma ES la confirmación.
   *
   * El trigger handle_new_user se dispara con el INSERT a auth.users y:
   *   - Si invitation.employee_id está set → linkea el employee existente
   *   - Else → crea employee nuevo (path ad-hoc /team)
   *   - Marca la invitación consumed.
   *
   * Devuelve un access_token + refresh_token para que el frontend pueda
   * loguear al user automáticamente (sin pasar por /login).
   */
  @Post('invitations/:token/accept')
  @Public()
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string };
  }> {
    // Lookup de la invitación (sin RLS — service_role).
    const { data: inv, error: invErr } = await this.supabase
      .from('auth_invitations')
      .select('id, email, phone_number, expires_at, consumed_at')
      .eq('token', token)
      .maybeSingle();
    if (invErr || !inv) {
      throw new NotFoundException('Invitation not found');
    }
    if (inv.consumed_at) {
      throw new ConflictException('Invitation already used');
    }
    if (new Date(inv.expires_at as string) < new Date()) {
      throw new ConflictException('Invitation expired');
    }
    if (!inv.email) {
      // Path phone-only no implementado — necesita SMS OTP, no password.
      throw new BadRequestException(
        'Phone-based invitations not supported via this endpoint',
      );
    }

    // 1) Crear el user en auth.users con email auto-confirmed. El trigger
    //    handle_new_user fires y linkea/crea el employee.
    const { data: created, error: createErr } =
      await this.supabase.auth.admin.createUser({
        email: inv.email as string,
        password: dto.password,
        email_confirm: true,
        user_metadata: { name: dto.name },
      });
    if (createErr || !created?.user) {
      // Si el user ya existe (raro pero posible si re-aceptan), avisamos.
      if (createErr?.message?.toLowerCase().includes('already')) {
        throw new ConflictException(
          'A user with this email already exists. Try logging in.',
        );
      }
      throw new Error(createErr?.message ?? 'Failed to create user');
    }

    // 2) Logueamos al recién creado para devolver tokens. Usamos el anon
    //    client porque `signInWithPassword` necesita ese rol (no service).
    const { data: session, error: signInErr } =
      await this.supabaseAnon.auth.signInWithPassword({
        email: inv.email as string,
        password: dto.password,
      });
    if (signInErr || !session?.session) {
      // El user quedó creado igual; el frontend puede mandarlo a /login.
      // No es 500 — es un edge case (rate limit, etc).
      throw new Error(
        `User created but auto-login failed: ${signInErr?.message ?? 'no session'}`,
      );
    }

    return {
      accessToken: session.session.access_token,
      refreshToken: session.session.refresh_token,
      user: {
        id: created.user.id,
        email: created.user.email ?? (inv.email as string),
      },
    };
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
  async previewInvitation(@Param('token') token: string): Promise<{
    email: string | null;
    phoneNumber: string | null;
    role: 'owner' | 'manager' | 'employee';
    companyName: string | null;
    expiresAt: string;
  }> {
    const { data, error } = await this.supabase
      .from('auth_invitations')
      .select('email, phone_number, role, expires_at, consumed_at, company_id')
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

  /**
   * POST /auth/audit-event — el cliente reporta una acción de auth
   * recién completada (login, MFA enroll, password change, logout).
   * Requiere JWT válido: el `auth_user_id` y el `company_id` vienen
   * del token, no del body — el cliente solo aporta el evento y
   * metadata libre.
   *
   * Eventos NO postables desde acá (los emite el server):
   *   - `login_fail`: pre-auth, no hay JWT. Para captura confiable se
   *     necesita un Supabase Auth Hook (configurado en el dashboard)
   *     posteando a este endpoint con service-role o a un endpoint
   *     dedicado @Public con shared-secret.
   *   - `permission_denied`: lo escribe `RolesGuard` cuando bloquea.
   *   - `role_changed`: lo escribe el admin endpoint correspondiente.
   *
   * Throttle moderado: el cliente legítimo postea 1–2 por sesión.
   * 30/min/IP deja margen para tests + reconnects sin abrir flood.
   */
  @Post('audit-event')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async logAuditEvent(
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
    @Body() dto: CreateAuthAuditEventDto,
  ): Promise<void> {
    try {
      await this.supabase.from('auth_audit_log').insert({
        company_id: user.companyId,
        auth_user_id: user.userId,
        employee_id: user.employeeId,
        event: dto.event,
        ip_address: req.ip ?? null,
        user_agent: req.headers['user-agent'] ?? null,
        metadata: dto.metadata ?? null,
      });
    } catch {
      // Auditing nunca debe bloquear el response al user.
    }
  }

  private toInvitationRow = (r: Record<string, unknown>): InvitationRow => ({
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
