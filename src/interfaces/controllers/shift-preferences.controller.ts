import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  IsUUID,
} from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { ManagerNotificationService } from '../../application/services/manager-notification.service';

export type ShiftPreferenceKind =
  | 'prefer_to_work'
  | 'available_hours'
  | 'prefer_specific_shift';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

class CreateShiftPreferenceDto {
  @IsIn(['prefer_to_work', 'available_hours', 'prefer_specific_shift'])
  kind!: ShiftPreferenceKind;

  /** YYYY-MM-DD. Omitir si la preferencia es solo recurrente por weekday. */
  @IsOptional()
  @IsISO8601()
  date?: string;

  /** 0=domingo … 6=sábado. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  repeatsWeekday?: number;

  /** Fecha final de la recurrencia. Solo si repeatsWeekday está set. */
  @IsOptional()
  @IsISO8601()
  repeatsUntil?: string;

  /** HH:MM o HH:MM:SS. Requerido si kind=available_hours. */
  @IsOptional()
  @Matches(TIME_RE, { message: 'startTime must be HH:MM' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME_RE, { message: 'endTime must be HH:MM' })
  endTime?: string;

  /** Requerido si kind=prefer_specific_shift. */
  @IsOptional()
  @IsUUID('loose')
  shiftTemplateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export interface ShiftPreferenceRow {
  id: string;
  companyId: string;
  employeeId: string;
  kind: ShiftPreferenceKind;
  date: string | null;
  repeatsWeekday: number | null;
  repeatsUntil: string | null;
  startTime: string | null;
  endTime: string | null;
  shiftTemplateId: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * ShiftPreferencesController — hints positivos del empleado.
 *
 *   POST   /shift-preferences         → employee crea (self)
 *   GET    /shift-preferences         → list (employee=propias, manager=todas del tenant)
 *   DELETE /shift-preferences/:id     → employee borra las suyas
 *
 * El employee solo gestiona las propias (RLS + check). El manager/owner
 * solo LEE para que el solver pueda aprovecharlas; no las edita ni
 * aprueba (son hints, no workflow). Cuando un employee crea una pref,
 * se emite WS `ApprovalsChanged` al tenant (la campanita del manager
 * la levanta) y se loguea para que después el outbound WhatsApp del
 * próximo sprint lo dispare.
 */
@Controller('shift-preferences')
@AllowExpiredTrial()
export class ShiftPreferencesController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly notifications: NotificationsGateway,
    private readonly managerNotifications: ManagerNotificationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Body() dto: CreateShiftPreferenceDto,
  ): Promise<ShiftPreferenceRow> {
    if (!user?.employeeId) {
      throw new ForbiddenException(
        'Only linked employees can create shift preferences',
      );
    }
    if (!dto.date && dto.repeatsWeekday === undefined) {
      throw new BadRequestException(
        'Either `date` or `repeatsWeekday` must be provided',
      );
    }
    if (dto.kind === 'available_hours' && (!dto.startTime || !dto.endTime)) {
      throw new BadRequestException(
        'available_hours requires both `startTime` and `endTime`',
      );
    }
    if (dto.kind === 'prefer_specific_shift' && !dto.shiftTemplateId) {
      throw new BadRequestException(
        'prefer_specific_shift requires `shiftTemplateId`',
      );
    }

    const { data, error } = await this.supabase
      .from('shift_preferences')
      .insert({
        company_id: companyId,
        employee_id: user.employeeId,
        kind: dto.kind,
        date: dto.date ?? null,
        repeats_weekday: dto.repeatsWeekday ?? null,
        repeats_until: dto.repeatsUntil ?? null,
        start_time: dto.startTime ?? null,
        end_time: dto.endTime ?? null,
        shift_template_id: dto.shiftTemplateId ?? null,
        note: dto.note ?? null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);

    // Notificar al manager. WS refresca la campanita inmediato;
    // WhatsApp es fire-and-forget al manager del depto (resuelve
    // ManagerNotificationService).
    this.notifications.notifyApprovalsChanged(companyId, 'shift_preference');
    const employeeName = await this.lookupEmployeeName(
      companyId,
      user.employeeId,
    );
    void this.managerNotifications.notifyManagerForEmployee(
      companyId,
      user.employeeId,
      buildPrefMessage(employeeName, dto),
    );

    return this.toRow(data);
  }

  @Get()
  async list(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('employeeId') employeeIdFilter?: string,
  ): Promise<ShiftPreferenceRow[]> {
    let q = this.supabase
      .from('shift_preferences')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: true, nullsFirst: false });

    // Empleado regular ve solo las suyas. Manager/owner ven todas
    // (RLS también lo enforza; el filter explícito es defensivo).
    if (user?.role === 'employee' && user.employeeId) {
      q = q.eq('employee_id', user.employeeId);
    } else if (employeeIdFilter) {
      q = q.eq('employee_id', employeeIdFilter);
    }
    if (from) q = q.gte('date', from);
    if (to) q = q.lte('date', to);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => this.toRow(r));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthContext | undefined,
  ): Promise<void> {
    if (!user?.employeeId) {
      throw new ForbiddenException('No linked employee');
    }
    const { data: existing, error: findErr } = await this.supabase
      .from('shift_preferences')
      .select('id, employee_id, company_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (findErr) throw new BadRequestException(findErr.message);
    if (!existing) throw new NotFoundException(`Preference ${id} not found`);
    // Solo el dueño borra. Manager NO borra preferencias ajenas
    // (son hints suaves; si quiere ignorarlas el solver lo hace).
    if (existing.employee_id !== user.employeeId) {
      throw new ForbiddenException(
        'Cannot delete another employee preference',
      );
    }
    const { error: delErr } = await this.supabase
      .from('shift_preferences')
      .delete()
      .eq('id', id);
    if (delErr) throw new BadRequestException(delErr.message);
    this.notifications.notifyApprovalsChanged(companyId, 'shift_preference');
  }

  private toRow(r: Record<string, unknown>): ShiftPreferenceRow {
    return {
      id: r.id as string,
      companyId: r.company_id as string,
      employeeId: r.employee_id as string,
      kind: r.kind as ShiftPreferenceKind,
      date: (r.date as string | null) ?? null,
      repeatsWeekday: (r.repeats_weekday as number | null) ?? null,
      repeatsUntil: (r.repeats_until as string | null) ?? null,
      startTime: (r.start_time as string | null) ?? null,
      endTime: (r.end_time as string | null) ?? null,
      shiftTemplateId: (r.shift_template_id as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  private async lookupEmployeeName(
    companyId: string,
    employeeId: string,
  ): Promise<string> {
    const { data } = await this.supabase
      .from('employees')
      .select('name')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    return (data?.name as string | undefined) ?? 'Employee';
  }
}

/**
 * Construye el WhatsApp para el manager. Texto plano corto — Twilio
 * tiene ~1600 chars de límite y el manager lo lee en el celular.
 * NOTA: i18n del outbound queda como follow-up — por ahora español
 * por default (la mayoría de los tenants son LatAm).
 */
function buildPrefMessage(
  employeeName: string,
  dto: { kind: ShiftPreferenceKind; date?: string; startTime?: string; endTime?: string; note?: string },
): string {
  const date = dto.date ?? '—';
  switch (dto.kind) {
    case 'prefer_to_work':
      return `${employeeName} quiere trabajar el ${date}.${dto.note ? '\nNota: ' + dto.note : ''}`;
    case 'available_hours':
      return `${employeeName} está disponible el ${date} de ${dto.startTime} a ${dto.endTime}.${dto.note ? '\nNota: ' + dto.note : ''}`;
    case 'prefer_specific_shift':
      return `${employeeName} prefiere un turno específico el ${date}.${dto.note ? '\nNota: ' + dto.note : ''}`;
  }
}

