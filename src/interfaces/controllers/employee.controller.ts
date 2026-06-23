import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  ENTITY_AUDIT_SERVICE,
  computeChangeSet,
  snapshotAsChangeSet,
  type IEntityAuditService,
} from '../../domain/audit/entity-audit.service';
import { Inject } from '@nestjs/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { RegisterEmployeeCommand } from '../../application/commands/register-employee.command';
import { UpdateEmployeeCommand } from '../../application/commands/update-employee.command';
import { DeleteEmployeeCommand } from '../../application/commands/delete-employee.command';
import { GetEmployeeCalendarQuery } from '../../application/queries/get-employee-calendar.query';
import { GetCompanyEmployeesQuery } from '../../application/queries/get-company-employees.query';
import { GetEmployeeByIdQuery } from '../../application/queries/get-employee-by-id.query';
import { GetCompanyScheduleQuery } from '../../application/queries/get-company-schedule.query';
import type { CompanyScheduleAssignmentDTO } from '../../application/handlers/get-company-schedule.handler';
import { PhoneNumber } from '../../domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../domain/value-objects/experience-level.vo';
import { RegisterEmployeeDto } from '../dtos/register-employee.dto';
import { GetEmployeeCalendarDto } from '../dtos/get-employee-calendar.dto';
import { UpdateEmployeeDto } from '../dtos/update-employee.dto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { EmailService } from '../../infrastructure/notifications/email.service';
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

/** Body de PATCH /employees/me/locale — el empleado cambia su propio idioma. */
export class UpdateMyLocaleDto {
  @IsIn(['es', 'en'])
  locale!: 'es' | 'en';
}

/** Body de PUT /employees/:id/locations — set de locaciones permitidas + modo. */
export class SetEmployeeLocationsDto {
  @IsArray()
  @IsString({ each: true })
  locationIds!: string[];

  @IsIn(['fixed', 'rotate'])
  mode!: 'fixed' | 'rotate';
}

/**
 * Body de POST /employees/locations/bulk — asignación masiva.
 * Suma (unión) las `locationIds` a cada empleado de `employeeIds` sin borrar
 * las que ya tenían. Si llega `mode`, lo aplica a todos; si no, no lo toca.
 */
export class BulkEmployeeLocationsDto {
  @IsArray()
  @IsString({ each: true })
  employeeIds!: string[];

  @IsArray()
  @IsString({ each: true })
  locationIds!: string[];

  @IsOptional()
  @IsIn(['fixed', 'rotate'])
  mode?: 'fixed' | 'rotate';
}

interface EmployeeLocationDTO {
  id: string;
  branchId: string;
  name: string;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusM: number;
}

/**
 * EmployeeController — Interfaces Layer
 *
 * Responsabilidad: traducir HTTP ↔ Commands/Queries.
 * No contiene lógica de negocio. Construye VOs del dominio
 * y delega al CommandBus / QueryBus.
 *
 * Multi-tenant: El company_id se extrae del header X-Company-Id
 * (ya procesado por TenantMiddleware, disponible en TenantContext).
 * Aquí lo leemos del header directamente para construir los commands.
 *
 * 💡 Rangos de experiencia por defecto (configurable por empresa en Fase futura)
 */
const DEFAULT_RANGES = { junior: 6, intermediate: 24, senior: 999 };

@Controller('employees')
export class EmployeeController {
  /** TTL default de invitaciones — 7 días (igual que en AuthController). */
  private static readonly INVITATION_TTL_HOURS = 24 * 7;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly emailService: EmailService,
    private readonly tenantFeatures: TenantFeatureService,
  ) {}

  private async ensureLocationsEnabled(companyId: string): Promise<void> {
    const on = await this.tenantFeatures.isEnabled(companyId, 'locations');
    if (!on) {
      throw new BadRequestException(
        'The "locations" feature is not enabled for this company',
      );
    }
  }

  /**
   * Bookkeeping HR fields que viven a nivel de tabla `employees` pero NO
   * en el aggregate. Hoy: `email`. El aggregate no los modela porque no
   * tienen invariantes de negocio — solo persistencia + uso UI.
   */
  private async upsertEmployeeEmail(
    employeeId: string,
    companyId: string,
    email: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('employees')
      .update({ email })
      .eq('id', employeeId)
      .eq('company_id', companyId);
    if (error) {
      // 23505 = unique violation. La constraint dice email único por
      // company → 409 al caller en lugar de 500.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(
          `Another employee in this company already has the email ${email}`,
        );
      }
      throw new Error(error.message);
    }
  }

  /**
   * Crea una `auth_invitations` row vinculada al employee y le manda el
   * email vía Resend. Idempotente: si ya existe una pending no expirada
   * para el mismo employee, la reusa (no genera token nuevo). Si está
   * expirada/consumida, genera nueva.
   *
   * Devuelve el token (por si la UI lo quiere mostrar como link copyable).
   * Si el send del mail falla, la row de invitación queda creada igual
   * — el manager puede copiar el link manual.
   */
  private async dispatchInvitation(params: {
    employeeId: string;
    companyId: string;
    email: string;
    role: 'manager' | 'employee';
    departmentId: string | null;
    invitedBy: string | null;
  }): Promise<{ token: string; reused: boolean }> {
    // ¿Ya hay una pending activa para este employee?
    const { data: existing } = await this.supabase
      .from('auth_invitations')
      .select('id, token, expires_at')
      .eq('employee_id', params.employeeId)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    let token: string;
    let reused = false;
    if (existing) {
      token = existing.token as string;
      reused = true;
    } else {
      token = randomBytes(32).toString('hex');
      const expiresAt = new Date(
        Date.now() + EmployeeController.INVITATION_TTL_HOURS * 60 * 60 * 1000,
      );
      const { error: insErr } = await this.supabase
        .from('auth_invitations')
        .insert({
          company_id: params.companyId,
          invited_by: params.invitedBy,
          email: params.email,
          phone_number: null,
          role: params.role,
          department_id: params.departmentId,
          employee_id: params.employeeId,
          token,
          expires_at: expiresAt.toISOString(),
        });
      if (insErr) throw new Error(insErr.message);
    }

    // Resolver nombres para el template.
    let inviterName = 'A manager';
    if (params.invitedBy) {
      const { data: inviter } = await this.supabase
        .from('employees')
        .select('name')
        .eq('id', params.invitedBy)
        .maybeSingle();
      if (inviter?.name) inviterName = inviter.name as string;
    }
    let companyName = 'Your company';
    const { data: co } = await this.supabase
      .from('companies')
      .select('name')
      .eq('id', params.companyId)
      .maybeSingle();
    if (co?.name) companyName = co.name as string;

    try {
      await this.emailService.sendInvitation({
        to: params.email,
        token,
        companyName,
        inviterName,
        role: params.role,
      });
    } catch (err) {
      // Log y seguimos — la row queda válida; el manager puede mandar
      // el link manual via "Copy link".

      console.warn(
        `dispatchInvitation: email send failed for ${params.email}: ${(err as Error).message}`,
      );
    }
    return { token, reused };
  }

  /**
   * Enriquece DTOs de empleados con email + estado de cuenta (active /
   * pending / none). Una sola query a `employees` por batch + una query
   * a `auth_invitations` para pending por employee_id.
   */
  private async enrichWithAccountStatus<T extends { id: string }>(
    dtos: T[],
    companyId: string,
  ): Promise<
    Array<
      T & {
        email: string | null;
        accountStatus: 'active' | 'pending' | 'none';
      }
    >
  > {
    if (dtos.length === 0) return [];
    const ids = dtos.map((d) => d.id);
    const { data: rows } = await this.supabase
      .from('employees')
      .select('id, email, auth_user_id')
      .in('id', ids)
      .eq('company_id', companyId);
    const byId = new Map<
      string,
      { email: string | null; authUserId: string | null }
    >();
    for (const r of rows ?? []) {
      byId.set(r.id as string, {
        email: (r.email as string | null) ?? null,
        authUserId: (r.auth_user_id as string | null) ?? null,
      });
    }
    const { data: pending } = await this.supabase
      .from('auth_invitations')
      .select('employee_id')
      .in('employee_id', ids)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString());
    const pendingSet = new Set(
      (pending ?? []).map((p) => p.employee_id as string),
    );

    return dtos.map((d) => {
      const meta = byId.get(d.id);
      const status: 'active' | 'pending' | 'none' = meta?.authUserId
        ? 'active'
        : pendingSet.has(d.id)
          ? 'pending'
          : 'none';
      return {
        ...d,
        email: meta?.email ?? null,
        accountStatus: status,
      };
    });
  }

  private auditFields = [
    'name',
    'phone',
    'experienceMonths',
    'locale',
    'role',
    'departmentId',
  ] as const;

  /**
   * POST /employees
   * Registra un nuevo empleado en la empresa del tenant actual.
   */
  @Post()
  @Requires('employees:write')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterEmployeeDto,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<{ employeeId: string; invitationSent?: boolean }> {
    const phone = PhoneNumber.create(dto.phone);
    const experience = new ExperienceLevel(
      dto.experienceMonths,
      DEFAULT_RANGES,
    );
    const employeeId = dto.employeeId ?? crypto.randomUUID();

    await this.commandBus.execute(
      new RegisterEmployeeCommand(
        employeeId,
        companyId,
        dto.name,
        phone,
        experience,
        dto.externalId,
      ),
    );

    // Email es bookkeeping HR (no en aggregate). Update directo +
    // dispatch automático de invitación si el email vino.
    let invitationSent = false;
    if (dto.email) {
      await this.upsertEmployeeEmail(employeeId, companyId, dto.email);
      const { data: empRow } = await this.supabase
        .from('employees')
        .select('role, department_id')
        .eq('id', employeeId)
        .maybeSingle();
      const role: 'manager' | 'employee' =
        (empRow?.role as string) === 'manager' ? 'manager' : 'employee';
      await this.dispatchInvitation({
        employeeId,
        companyId,
        email: dto.email,
        role,
        departmentId: (empRow?.department_id as string | null) ?? null,
        invitedBy: user?.employeeId ?? null,
      });
      invitationSent = true;
    }

    // Department es bookkeeping HR (no en el aggregate, igual que email).
    // Persistimos directo; define la sucursal vía department→branch.
    if (dto.departmentId) {
      const { error } = await this.supabase
        .from('employees')
        .update({ department_id: dto.departmentId })
        .eq('id', employeeId)
        .eq('company_id', companyId);
      if (error) {
        // 23503 = FK violation → el department no existe / no es del tenant.
        if ((error as { code?: string }).code === '23503') {
          throw new BadRequestException(
            `Department ${dto.departmentId} does not exist in this company`,
          );
        }
        throw new Error(error.message);
      }
    }

    const created = await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null);
    if (created) {
      await this.audit.log({
        companyId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'create',
        changes: snapshotAsChangeSet(
          this.pickAuditFields(created as Record<string, unknown>),
          'create',
        ),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }

    return { employeeId, invitationSent };
  }

  private pickAuditFields(
    emp: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.auditFields.reduce<Record<string, unknown>>((acc, f) => {
      acc[f] = emp[f] ?? null;
      return acc;
    }, {});
  }

  /**
   * GET /employees
   * Devuelve todos los empleados de la empresa, enriquecidos con email
   * + accountStatus (active|pending|none) para que la UI de "Team"
   * muestre badges + acción "Resend invite".
   */
  @Get()
  async getEmployees(@CurrentCompany() companyId: string): Promise<
    Array<{
      id: string;
      email: string | null;
      accountStatus: 'active' | 'pending' | 'none';
    }>
  > {
    const dtos = await this.queryBus.execute(
      new GetCompanyEmployeesQuery(companyId),
    );
    return this.enrichWithAccountStatus(dtos, companyId);
  }

  /**
   * POST /employees/:id/resend-invite — re-dispara la invitación al
   * email del employee. Idempotente: si hay una pending no expirada,
   * la reusa; si no, genera token nuevo. 404 si el employee no existe
   * en este tenant. 409 si ya tiene cuenta (no se puede re-invitar).
   * 400 si el employee no tiene email cargado.
   */
  @Post(':id/resend-invite')
  @Requires('employees:write')
  @HttpCode(HttpStatus.OK)
  async resendInvite(
    @Param('id') employeeId: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<{ ok: true; reused: boolean }> {
    const { data: emp } = await this.supabase
      .from('employees')
      .select('id, email, role, department_id, auth_user_id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!emp) {
      throw new NotFoundException(`Employee ${employeeId} not found`);
    }
    if (emp.auth_user_id) {
      throw new ConflictException(
        'Employee already has an active account; cannot resend invite',
      );
    }
    if (!emp.email) {
      throw new ConflictException(
        'Employee has no email — set one via edit before sending invite',
      );
    }
    const role: 'manager' | 'employee' =
      (emp.role as string) === 'manager' ? 'manager' : 'employee';
    const result = await this.dispatchInvitation({
      employeeId,
      companyId,
      email: emp.email as string,
      role,
      departmentId: (emp.department_id as string | null) ?? null,
      invitedBy: user?.employeeId ?? null,
    });
    return { ok: true, reused: result.reused };
  }

  /**
   * GET /employees/me
   * Perfil del empleado autenticado (vista del propio empleado en la app
   * móvil). Reusa GetEmployeeByIdQuery con el employeeId del JWT y enriquece
   * con email + nombre de la empresa. Declarado ANTES de `:id` para que la
   * ruta estática gane sobre el param.
   */
  @Get('me')
  async getMe(
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{
    id: string;
    name: string;
    role: string | null;
    phone: string | null;
    departmentId: string | null;
    email: string | null;
    companyName: string | null;
    timezone: string | null;
    locale: string | null;
  }> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    const emp = await this.queryBus.execute(
      new GetEmployeeByIdQuery(user.employeeId, companyId),
    );
    const [{ data: empRow }, { data: co }] = await Promise.all([
      this.supabase
        .from('employees')
        .select('email')
        .eq('id', user.employeeId)
        .eq('company_id', companyId)
        .maybeSingle(),
      this.supabase
        .from('companies')
        .select('name')
        .eq('id', companyId)
        .maybeSingle(),
    ]);
    // The wall-clock timezone the employee sees lives on their branch.
    // Resolve employee → department → branch.timezone (null if unassigned).
    const timezone = await this.resolveEmployeeTimezone(
      emp.departmentId,
      companyId,
    );
    return {
      id: emp.id,
      name: emp.name,
      role: emp.role,
      phone: emp.phone,
      departmentId: emp.departmentId,
      email: (empRow?.email as string | null) ?? null,
      companyName: (co?.name as string | null) ?? null,
      timezone,
      locale: emp.locale ?? null,
    };
  }

  /**
   * PATCH /employees/me/locale — el empleado cambia su propio idioma.
   * Self-service (sin permiso de manager): el employeeId sale del JWT.
   * El cliente (móvil/web) sincroniza acá su idioma efectivo para que las
   * notificaciones del servidor (push/WhatsApp) salgan en ese idioma.
   */
  @Patch('me/locale')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyLocale(
    @Body() dto: UpdateMyLocaleDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    await this.commandBus.execute(
      new UpdateEmployeeCommand(user.employeeId, companyId, {
        locale: dto.locale,
      }),
    );
  }

  private async resolveEmployeeTimezone(
    departmentId: string | null,
    companyId: string,
  ): Promise<string | null> {
    if (!departmentId) return null;
    const { data: dept } = await this.supabase
      .from('departments')
      .select('branch_id')
      .eq('id', departmentId)
      .eq('company_id', companyId)
      .maybeSingle();
    const branchId = (dept?.branch_id as string | null) ?? null;
    if (!branchId) return null;
    const { data: branch } = await this.supabase
      .from('branches')
      .select('timezone')
      .eq('id', branchId)
      .eq('company_id', companyId)
      .maybeSingle();
    return (branch?.timezone as string | null) ?? null;
  }

  /**
   * GET /employees/me/schedule?weekStart=YYYY-MM-DD
   * Turnos del empleado autenticado para la semana. Reusa
   * GetCompanyScheduleQuery filtrando por el employeeId del JWT — el
   * empleado solo ve lo suyo, el tenant viene del token.
   */
  @Get('me/schedule')
  async getMySchedule(
    @Query('weekStart') weekStart: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<CompanyScheduleAssignmentDTO[]> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new BadRequestException('weekStart (YYYY-MM-DD) is required');
    }
    return this.queryBus.execute(
      new GetCompanyScheduleQuery(
        companyId,
        weekStart,
        undefined,
        user.employeeId,
      ),
    );
  }

  /**
   * GET /employees/me/locations
   * Locaciones permitidas del empleado autenticado + su modo (app móvil).
   * Declarado antes de `:id`. Requiere la feature 'locations'.
   */
  @Get('me/locations')
  async getMyLocations(
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ mode: 'fixed' | 'rotate'; locations: EmployeeLocationDTO[] }> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    await this.ensureLocationsEnabled(companyId);
    const [{ data: emp }, { data: rows }] = await Promise.all([
      this.supabase
        .from('employees')
        .select('location_mode')
        .eq('id', user.employeeId)
        .eq('company_id', companyId)
        .maybeSingle(),
      this.supabase
        .from('employee_locations')
        .select(
          'locations(id, branch_id, name, geofence_lat, geofence_lng, geofence_radius_m, is_active)',
        )
        .eq('employee_id', user.employeeId)
        .eq('company_id', companyId),
    ]);
    const mode =
      (emp?.location_mode as string) === 'fixed' ? 'fixed' : 'rotate';
    type LocRow = {
      id: string;
      branch_id: string;
      name: string;
      geofence_lat: number;
      geofence_lng: number;
      geofence_radius_m: number;
      is_active: boolean;
    };
    // supabase types the to-one embed as an array; normalize array-or-object.
    const typed = (rows ?? []) as unknown as Array<{
      locations: LocRow | LocRow[] | null;
    }>;
    const locations: EmployeeLocationDTO[] = typed
      .map((r) => (Array.isArray(r.locations) ? r.locations[0] : r.locations))
      .filter((l): l is LocRow => !!l && l.is_active)
      .map((l) => ({
        id: l.id,
        branchId: l.branch_id,
        name: l.name,
        geofenceLat: l.geofence_lat,
        geofenceLng: l.geofence_lng,
        geofenceRadiusM: l.geofence_radius_m,
      }));
    return { mode, locations };
  }

  /**
   * GET /employees/:id/locations — locaciones permitidas + modo (vista manager).
   */
  @Get(':id/locations')
  async getEmployeeLocations(
    @Param('id') employeeId: string,
    @CurrentCompany() companyId: string,
  ): Promise<{ mode: 'fixed' | 'rotate'; locationIds: string[] }> {
    await this.ensureLocationsEnabled(companyId);
    const [{ data: emp }, { data: rows }] = await Promise.all([
      this.supabase
        .from('employees')
        .select('location_mode')
        .eq('id', employeeId)
        .eq('company_id', companyId)
        .maybeSingle(),
      this.supabase
        .from('employee_locations')
        .select('location_id')
        .eq('employee_id', employeeId)
        .eq('company_id', companyId),
    ]);
    if (!emp) throw new NotFoundException(`Employee ${employeeId} not found`);
    const mode = (emp.location_mode as string) === 'fixed' ? 'fixed' : 'rotate';
    return {
      mode,
      locationIds: (rows ?? []).map((r) => r.location_id as string),
    };
  }

  /**
   * PUT /employees/:id/locations — set de locaciones permitidas + modo.
   * Reemplaza el set completo. Valida que las locaciones sean del tenant.
   */
  @Put(':id/locations')
  @Requires('employees:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setEmployeeLocations(
    @Param('id') employeeId: string,
    @Body() dto: SetEmployeeLocationsDto,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.ensureLocationsEnabled(companyId);
    const { data: emp } = await this.supabase
      .from('employees')
      .select('id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!emp) throw new NotFoundException(`Employee ${employeeId} not found`);

    const ids = [...new Set(dto.locationIds)];
    if (ids.length) {
      const { data: locs } = await this.supabase
        .from('locations')
        .select('id')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .in('id', ids);
      const valid = new Set((locs ?? []).map((l) => l.id as string));
      const bad = ids.filter((i) => !valid.has(i));
      if (bad.length) {
        throw new BadRequestException(`Unknown location(s): ${bad.join(', ')}`);
      }
    }

    const { error: upErr } = await this.supabase
      .from('employees')
      .update({ location_mode: dto.mode })
      .eq('id', employeeId)
      .eq('company_id', companyId);
    if (upErr) throw new Error(upErr.message);

    const { error: delErr } = await this.supabase
      .from('employee_locations')
      .delete()
      .eq('employee_id', employeeId)
      .eq('company_id', companyId);
    if (delErr) throw new Error(delErr.message);

    if (ids.length) {
      const { error: insErr } = await this.supabase
        .from('employee_locations')
        .insert(
          ids.map((location_id) => ({
            company_id: companyId,
            employee_id: employeeId,
            location_id,
          })),
        );
      if (insErr) throw new Error(insErr.message);
    }
  }

  /**
   * POST /employees/locations/bulk — asignación masiva (suma/unión).
   * Agrega las locaciones a cada empleado sin borrar las que ya tenían;
   * setea el modo si viene. Declarado antes de las rutas `:id`.
   */
  @Post('locations/bulk')
  @Requires('employees:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async bulkAddLocations(
    @Body() dto: BulkEmployeeLocationsDto,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.ensureLocationsEnabled(companyId);
    const empIds = [...new Set(dto.employeeIds)];
    const locIds = [...new Set(dto.locationIds)];
    if (empIds.length === 0 || locIds.length === 0) {
      throw new BadRequestException('employeeIds and locationIds are required');
    }
    const { data: locs } = await this.supabase
      .from('locations')
      .select('id')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('id', locIds);
    const validLoc = new Set((locs ?? []).map((l) => l.id as string));
    const badLoc = locIds.filter((i) => !validLoc.has(i));
    if (badLoc.length) {
      throw new BadRequestException(
        `Unknown location(s): ${badLoc.join(', ')}`,
      );
    }
    const { data: emps } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .in('id', empIds);
    const targetEmps = (emps ?? []).map((e) => e.id as string);
    if (targetEmps.length === 0) {
      throw new BadRequestException('No valid employees in this company');
    }
    const rows = targetEmps.flatMap((eid) =>
      locIds.map((lid) => ({
        company_id: companyId,
        employee_id: eid,
        location_id: lid,
      })),
    );
    const { error } = await this.supabase
      .from('employee_locations')
      .upsert(rows, {
        onConflict: 'employee_id,location_id',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);

    if (dto.mode) {
      const { error: mErr } = await this.supabase
        .from('employees')
        .update({ location_mode: dto.mode })
        .eq('company_id', companyId)
        .in('id', targetEmps);
      if (mErr) throw new Error(mErr.message);
    }
  }

  /**
   * GET /employees/:id
   * Devuelve un empleado puntual por id dentro del tenant actual.
   */
  @Get(':id')
  async getById(
    @Param('id') employeeId: string,
    @CurrentCompany() companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(
      new GetEmployeeByIdQuery(employeeId, companyId),
    );
  }

  /**
   * GET /employees/:id/calendar?from=&to=
   * Retorna el calendario de turnos de un empleado en un rango de fechas.
   */
  @Get(':id/calendar')
  async getCalendar(
    @Param('id') employeeId: string,
    @Query() query: GetEmployeeCalendarDto,
    @CurrentCompany() companyId: string,
  ): Promise<unknown> {
    return this.queryBus.execute(
      new GetEmployeeCalendarQuery(
        employeeId,
        companyId,
        new Date(query.from),
        new Date(query.to),
      ),
    );
  }

  /**
   * PATCH /employees/:id
   * Actualiza parcialmente un empleado. Los campos no enviados quedan
   * intactos. Para limpiar un nullable, mandar `null` explícito.
   */
  @Patch(':id')
  @Requires('employees:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Param('id') employeeId: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const before = (await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null)) as Record<string, unknown> | null;
    await this.commandBus.execute(
      new UpdateEmployeeCommand(employeeId, companyId, dto),
    );

    // Email es bookkeeping HR. Si el caller manda uno y no es igual al
    // actual, lo persistimos directo + disparamos invitación cuando el
    // employee todavía no tiene auth_user_id (no perturbamos cuentas
    // activas).
    if (dto.email) {
      const { data: emp } = await this.supabase
        .from('employees')
        .select('email, role, department_id, auth_user_id')
        .eq('id', employeeId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (emp && emp.email !== dto.email) {
        await this.upsertEmployeeEmail(employeeId, companyId, dto.email);
      }
      if (emp && !emp.auth_user_id) {
        const role: 'manager' | 'employee' =
          (emp.role as string) === 'manager' ? 'manager' : 'employee';
        await this.dispatchInvitation({
          employeeId,
          companyId,
          email: dto.email,
          role,
          departmentId: (emp.department_id as string | null) ?? null,
          invitedBy: user?.employeeId ?? null,
        });
      }
    }

    const after = (await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null)) as Record<string, unknown> | null;
    if (before && after) {
      const beforeSnap = this.pickAuditFields(before) as Record<
        (typeof this.auditFields)[number],
        unknown
      >;
      const afterSnap = this.pickAuditFields(after) as Record<
        (typeof this.auditFields)[number],
        unknown
      >;
      await this.audit.log({
        companyId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'update',
        changes: computeChangeSet(beforeSnap, afterSnap, this.auditFields),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
  }

  /**
   * DELETE /employees/:id
   * Soft delete: marca `is_active=false` + `deleted_at=NOW()`.
   */
  @Delete(':id')
  @Requires('employees:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('id') employeeId: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    const before = (await this.queryBus
      .execute(new GetEmployeeByIdQuery(employeeId, companyId))
      .catch(() => null)) as Record<string, unknown> | null;
    await this.commandBus.execute(
      new DeleteEmployeeCommand(employeeId, companyId),
    );
    if (before) {
      await this.audit.log({
        companyId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'delete',
        changes: snapshotAsChangeSet(this.pickAuditFields(before), 'delete'),
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    }
  }
}
