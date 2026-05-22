import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { PlatformSuperAdmin } from '../../infrastructure/auth/decorators/platform-super-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

export type PlatformRole = 'super' | 'support';

export interface PlatformUserRow {
  id: string;
  authUserId: string;
  email: string;
  role: PlatformRole;
  createdAt: string;
  isSelf: boolean;
}

class CreatePlatformUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsIn(['super', 'support'])
  role?: PlatformRole;

  @IsOptional()
  @IsString()
  notes?: string;
}

class UpdateRoleDto {
  @IsIn(['super', 'support'])
  role!: PlatformRole;
}

/**
 * AdminPlatformUsersController — gestión de operadores de plataforma.
 *
 * Roles:
 *   - super:   puede crear/editar/borrar otros platform_admins
 *   - support: ve el panel y opera el resto de los endpoints pero NO
 *              modifica esta tabla
 *
 * Endpoints:
 *   GET    /admin/platform-users       → cualquier platform_admin
 *   POST   /admin/platform-users       → solo super
 *   PATCH  /admin/platform-users/:id   → solo super
 *   DELETE /admin/platform-users/:id   → solo super
 *
 * Restricciones:
 *   - No se puede demote/delete al último super (la plataforma quedaría
 *     sin nadie capaz de gestionar admins → lockout)
 *   - Crear un admin requiere que el email ya tenga cuenta en auth.users.
 *     No mandamos invite email — el flow es: el target user se registra
 *     normal, después un super lo agrega acá.
 *   - Cualquier cambio se audita en auth_audit_log
 *     (platform_admin_added | platform_admin_role_changed | platform_admin_removed)
 */
@Controller('admin/platform-users')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminPlatformUsersController {
  private readonly logger = new Logger(AdminPlatformUsersController.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get()
  async list(@CurrentUser() caller: AuthContext): Promise<PlatformUserRow[]> {
    const { data, error } = await this.supabase
      .from('platform_admins')
      .select('id, auth_user_id, email, role, created_at')
      .order('created_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      authUserId: r.auth_user_id as string,
      email: r.email as string,
      role: r.role as PlatformRole,
      createdAt: r.created_at as string,
      isSelf: r.auth_user_id === caller.userId,
    }));
  }

  @Post()
  @PlatformSuperAdmin()
  async create(
    @CurrentUser() caller: AuthContext,
    @Body() body: CreatePlatformUserDto,
    @Req() req: Request,
  ): Promise<PlatformUserRow> {
    // El target user tiene que existir en auth.users. Buscamos su id por email.
    const { data: usersData, error: usersErr } =
      await this.supabase.auth.admin.listUsers();
    if (usersErr) throw new BadRequestException(usersErr.message);
    const target = (usersData.users ?? []).find(
      (u) => u.email?.toLowerCase() === body.email.toLowerCase(),
    );
    if (!target) {
      throw new NotFoundException(
        `No user with email ${body.email}. They must create an account first.`,
      );
    }

    const role: PlatformRole = body.role ?? 'support';

    const { data, error } = await this.supabase
      .from('platform_admins')
      .insert({
        auth_user_id: target.id,
        email: target.email ?? body.email,
        role,
      })
      .select('id, auth_user_id, email, role, created_at')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new BadRequestException(
          `${body.email} is already a platform admin`,
        );
      }
      throw new BadRequestException(error.message);
    }

    await this.audit(req, caller, {
      event: 'platform_admin_added',
      target_auth_user_id: target.id,
      target_email: body.email,
      target_role: role,
      notes: body.notes ?? null,
    });

    return {
      id: data.id as string,
      authUserId: data.auth_user_id as string,
      email: data.email as string,
      role: data.role as PlatformRole,
      createdAt: data.created_at as string,
      isSelf: data.auth_user_id === caller.userId,
    };
  }

  @Patch(':id')
  @PlatformSuperAdmin()
  async updateRole(
    @CurrentUser() caller: AuthContext,
    @Param('id') id: string,
    @Body() body: UpdateRoleDto,
    @Req() req: Request,
  ): Promise<PlatformUserRow> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException('Platform admin not found');

    if (existing.role === body.role) {
      // No-op explícito; mejor devolver tal cual que tirar 400.
      return this.toRow(existing, caller);
    }

    // Si lo bajamos de super → support, asegurarse de que NO sea el
    // último super (sino quedamos sin nadie que gestione admins).
    if (existing.role === 'super' && body.role === 'support') {
      await this.assertNotLastSuper(existing.id);
    }

    const { data, error } = await this.supabase
      .from('platform_admins')
      .update({ role: body.role })
      .eq('id', id)
      .select('id, auth_user_id, email, role, created_at')
      .single();
    if (error) throw new BadRequestException(error.message);

    await this.audit(req, caller, {
      event: 'platform_admin_role_changed',
      target_auth_user_id: data.auth_user_id,
      target_email: data.email,
      from_role: existing.role,
      to_role: body.role,
    });

    return this.toRow(data, caller);
  }

  @Delete(':id')
  @PlatformSuperAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() caller: AuthContext,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException('Platform admin not found');
    if (existing.role === 'super') {
      await this.assertNotLastSuper(existing.id);
    }

    const { error } = await this.supabase
      .from('platform_admins')
      .delete()
      .eq('id', id);
    if (error) throw new BadRequestException(error.message);

    await this.audit(req, caller, {
      event: 'platform_admin_removed',
      target_auth_user_id: existing.auth_user_id,
      target_email: existing.email,
      target_role: existing.role,
    });
  }

  private async findById(id: string): Promise<{
    id: string;
    auth_user_id: string;
    email: string;
    role: PlatformRole;
    created_at: string;
  } | null> {
    const { data, error } = await this.supabase
      .from('platform_admins')
      .select('id, auth_user_id, email, role, created_at')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return data as {
      id: string;
      auth_user_id: string;
      email: string;
      role: PlatformRole;
      created_at: string;
    };
  }

  private async assertNotLastSuper(idAboutToChange: string): Promise<void> {
    const { count, error } = await this.supabase
      .from('platform_admins')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'super')
      .neq('id', idAboutToChange);
    if (error) throw new BadRequestException(error.message);
    if (!count || count === 0) {
      throw new BadRequestException(
        'Cannot demote or remove the last super admin — promote someone else first.',
      );
    }
  }

  private async audit(
    req: Request,
    caller: AuthContext,
    metadata: Record<string, unknown> & { event: string },
  ): Promise<void> {
    const { event, ...meta } = metadata;
    try {
      await this.supabase.from('auth_audit_log').insert({
        company_id: null,
        auth_user_id: caller.userId,
        employee_id: caller.employeeId,
        event,
        ip_address: req.ip ?? null,
        user_agent: req.headers['user-agent'] ?? null,
        metadata: { actor_auth_user_id: caller.userId, ...meta },
      });
    } catch (err) {
      this.logger.error(
        `Failed to audit ${event}: ${(err as Error).message}`,
      );
    }
  }

  private toRow(
    r: {
      id: string;
      auth_user_id: string;
      email: string;
      role: PlatformRole;
      created_at: string;
    },
    caller: AuthContext,
  ): PlatformUserRow {
    return {
      id: r.id,
      authUserId: r.auth_user_id,
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
      isSelf: r.auth_user_id === caller.userId,
    };
  }
}
