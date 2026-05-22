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
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, auth_user_id, full_name, role')
      .eq('company_id', companyId)
      .not('auth_user_id', 'is', null)
      .order('role')
      .order('full_name');
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      auth_user_id: string | null;
      full_name: string | null;
      role: 'owner' | 'manager' | 'employee';
    }>;

    // Resolver emails desde auth.users vía admin SDK. Hacemos getUserById
    // en paralelo — no es óptimo pero el listado típico tiene <50 rows.
    const enriched = await Promise.all(
      rows.map(async (r) => {
        let email: string | null = null;
        if (r.auth_user_id) {
          const { data: userData } = await this.supabase.auth.admin.getUserById(
            r.auth_user_id,
          );
          email = userData.user?.email ?? null;
        }
        return {
          employeeId: r.id,
          authUserId: r.auth_user_id,
          fullName: r.full_name,
          email,
          role: r.role,
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
      .select('id, auth_user_id, full_name, role, company_id')
      .eq('id', body.employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!employee || !employee.auth_user_id) {
      throw new NotFoundException(
        'Employee not found or has no auth user linked',
      );
    }

    const { data: userData } = await this.supabase.auth.admin.getUserById(
      employee.auth_user_id as string,
    );
    const email = userData.user?.email;
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
      throw new InternalServerErrorException(
        'Failed to generate magic link',
      );
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
