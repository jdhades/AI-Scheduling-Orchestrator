import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

export interface ImpersonateTargetRow {
  employeeId: string;
  authUserId: string | null;
  fullName: string | null;
  email: string | null;
  role: 'owner' | 'manager' | 'employee';
  /**
   * Estado del target para impersonar:
   *  - 'ready'   : tiene auth_user_id linkeado → magic link directo.
   *  - 'bootstrap': no tiene auth pero tiene email → el POST creará el
   *                 auth.user on-the-fly antes de emitir el link.
   *  - 'unavailable': no tiene email ni auth → no se puede impersonar.
   */
  status: 'ready' | 'bootstrap' | 'unavailable';
}

class ImpersonateDto {
  @IsUUID('loose')
  employeeId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * AdminImpersonateController — emite un magic link de Supabase para que
 * el soporte se loguee como un employee específico de un tenant.
 *
 * Flow:
 *   1. Admin abre dialog en el panel
 *   2. Selecciona employee a impersonar + escribe reason
 *   3. Backend chequea PlatformAdmin → emite magic link via Supabase
 *      admin SDK → escribe evento `impersonation_started` en auth_audit_log
 *   4. Admin abre el link → la sesión actual se reemplaza por la del
 *      target → para volver, logout + login normal
 *
 *   GET  /admin/companies/:id/impersonate-targets  → lista de employees
 *   POST /admin/companies/:id/impersonate          → genera el link
 *
 * Restricciones de seguridad:
 *   - Solo @PlatformAdmin() (decorator validates)
 *   - Solo email-based targets (employees con phone_only no funcionan)
 *   - Auditado SIEMPRE — la fila en auth_audit_log es lo que el manager
 *     del tenant usa para ver "soporte entró a mi cuenta el día X"
 *   - El magic link es one-time y expira en ~1h (default Supabase)
 */
@Controller('admin/companies/:id')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminImpersonateController {
  private readonly logger = new Logger(AdminImpersonateController.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  @Get('impersonate-targets')
  async listTargets(
    @Param('id') companyId: string,
  ): Promise<ImpersonateTargetRow[]> {
    // Listamos TODOS los employees del tenant (no filtramos por
    // auth_user_id). Para tenants creados via seed o WhatsApp, el owner
    // puede no tener auth todavía — el flow soporta bootstrap si hay
    // email en `employees.email`.
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, auth_user_id, full_name, email, role')
      .eq('company_id', companyId)
      .order('role')
      .order('full_name');
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      auth_user_id: string | null;
      full_name: string | null;
      email: string | null;
      role: 'owner' | 'manager' | 'employee';
    }>;

    // Resolver emails desde auth.users solo para los que tengan link.
    // Para los que no, usamos `employees.email` (sembrado por el manager
    // al crear el row). Hacemos getUserById en paralelo solo cuando hace
    // falta — no es óptimo pero el listado típico tiene <50 rows.
    const enriched = await Promise.all(
      rows.map(async (r) => {
        let email: string | null = r.email;
        if (r.auth_user_id) {
          const { data: userData } = await this.supabase.auth.admin.getUserById(
            r.auth_user_id,
          );
          // El email de auth.users gana sobre employees.email (es el que
          // efectivamente recibe el magic link).
          email = userData.user?.email ?? r.email;
        }
        const status: ImpersonateTargetRow['status'] = r.auth_user_id
          ? 'ready'
          : email
            ? 'bootstrap'
            : 'unavailable';
        return {
          employeeId: r.id,
          authUserId: r.auth_user_id,
          fullName: r.full_name,
          email,
          role: r.role,
          status,
        };
      }),
    );
    return enriched;
  }

  @Post('impersonate')
  async impersonate(
    @CurrentUser() admin: AuthContext,
    @Param('id') companyId: string,
    @Body() body: ImpersonateDto,
    @Req() req: Request,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const { data: employee, error } = await this.supabase
      .from('employees')
      .select('id, auth_user_id, full_name, email, role, company_id')
      .eq('id', body.employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!employee) {
      throw new NotFoundException('Employee not found in this tenant');
    }

    // Resolver auth_user_id + email. Si el employee NO tiene auth
    // linkeado todavía (tenant seedeado, alta vía WhatsApp, etc.) pero
    // tiene email cargado, creamos el auth.user on-the-fly + linkeamos.
    // De ese modo soporte siempre puede entrar al tenant sin que el
    // owner haya hecho self-signup primero.
    let authUserId: string | null = employee.auth_user_id as string | null;
    let email: string | null = null;

    if (authUserId) {
      const { data: userData } = await this.supabase.auth.admin.getUserById(
        authUserId,
      );
      email = userData.user?.email ?? null;
    } else {
      const employeeEmail = (employee.email as string | null)?.trim() || null;
      if (!employeeEmail) {
        throw new BadRequestException(
          'Employee has no email and no auth user — cannot bootstrap impersonation. Add an email to the employee first.',
        );
      }

      // Reusar auth.user existente si el email ya está registrado en
      // otro tenant (improbable pero posible). Si no existe, creamos.
      // `listUsers` no soporta filtro server-side por email — paginamos
      // y buscamos. Límite 200/página es suficiente para staging; en
      // tenants con 10k+ usuarios habría que cambiar a una query SQL
      // directa contra auth.users.
      const { data: existingUser } =
        await this.supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      const candidates = (existingUser?.users ?? []) as Array<{
        id: string;
        email?: string | null;
      }>;
      const found = candidates.find(
        (u) => u.email?.toLowerCase() === employeeEmail.toLowerCase(),
      );

      if (found) {
        authUserId = found.id;
        email = found.email ?? employeeEmail;
        this.logger.log(
          `Impersonate bootstrap: reusing existing auth.user ${authUserId} for ${employeeEmail}`,
        );
      } else {
        const { data: created, error: createErr } =
          await this.supabase.auth.admin.createUser({
            email: employeeEmail,
            email_confirm: true,
          });
        if (createErr || !created.user) {
          throw new InternalServerErrorException(
            `Failed to bootstrap auth user: ${createErr?.message ?? 'no user returned'}`,
          );
        }
        authUserId = created.user.id;
        email = created.user.email ?? employeeEmail;
        this.logger.log(
          `Impersonate bootstrap: created auth.user ${authUserId} for ${employeeEmail}`,
        );
      }

      // Linkear el auth_user_id al employee row.
      const { error: linkErr } = await this.supabase
        .from('employees')
        .update({ auth_user_id: authUserId })
        .eq('id', employee.id);
      if (linkErr) {
        throw new InternalServerErrorException(
          `Failed to link auth_user_id to employee: ${linkErr.message}`,
        );
      }
    }

    if (!email) {
      throw new BadRequestException(
        'Target user has no email — phone-only employees cannot be impersonated',
      );
    }

    // Generar magic link. El admin lo va a usar — la sesión del target
    // se materializa cuando el admin clickea la URL. El campo `url`
    // viene con el access_token + refresh_token embebidos.
    const { data: linkData, error: linkErr } =
      await this.supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: {
          redirectTo: this.buildAppUrl('/'),
        },
      });
    if (linkErr || !linkData.properties?.action_link) {
      this.logger.error(
        `Impersonate failed for ${email}: ${linkErr?.message ?? 'no action_link'}`,
      );
      throw new InternalServerErrorException('Failed to generate magic link');
    }

    // Auditar el evento. Crítico: este es el único registro durable de
    // que el admin entró a la cuenta del target.
    try {
      await this.supabase.from('auth_audit_log').insert({
        company_id: companyId,
        auth_user_id: employee.auth_user_id,
        employee_id: employee.id,
        event: 'impersonation_started',
        ip_address: req.ip ?? null,
        user_agent: req.headers['user-agent'] ?? null,
        metadata: {
          admin_auth_user_id: admin.userId,
          target_email: email,
          target_role: employee.role,
          reason: body.reason ?? null,
        },
      });
    } catch (auditErr) {
      // No abortamos el flow por un fallo de audit — pero lo logueamos
      // como ERROR (no warn) porque la ausencia del registro es seria.
      this.logger.error(
        `Failed to write impersonation audit row: ${(auditErr as Error).message}`,
      );
    }

    return {
      url: linkData.properties.action_link,
      // Supabase magic links default a 1 hora.
      expiresInSeconds: 3600,
    };
  }

  private buildAppUrl(path: string): string {
    const base =
      this.config.get<string>('APP_URL') ??
      this.config.get<string>('FRONTEND_URL') ??
      'http://localhost:5173';
    return `${base.replace(/\/$/, '')}${path}`;
  }
}
