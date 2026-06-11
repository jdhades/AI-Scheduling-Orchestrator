import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  evaluateGpsClock,
  type GeofenceConfig,
} from '../../domain/services/timeclock-evaluation';
import {
  ENTITY_AUDIT_SERVICE,
  type IEntityAuditService,
} from '../../domain/audit/entity-audit.service';
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';
import { CreateClockEventDto } from '../dtos/create-clock-event.dto';

/** Body de PATCH /timeclock/events/:id/review. */
export class ReviewClockEventDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Una fila de la hoja de horas (1 por turno). Las horas extra (día/semana) las
 *  calcula el front con la política de la empresa sobre estos totales. */
interface TimesheetRowDTO {
  shiftId: string;
  employeeId: string;
  employeeName: string | null;
  date: string; // YYYY-MM-DD
  templateName: string;
  branchName: string | null;
  departmentName: string | null;
  locationName: string | null;
  /** Horario planificado del turno (wall-clock UTC). */
  scheduledStart: string;
  scheduledEnd: string;
  /** Marcaje real. null si falta (ej. olvidó fichar). */
  clockIn: string | null;
  clockOut: string | null;
  /** IDs de los eventos in/out (para editar la hora). null si no hay. */
  clockInId: string | null;
  clockOutId: string | null;
  /** Razón si el fichaje fue corregido manualmente (badge "Corregido"). */
  correctionReason: string | null;
  breakCount: number;
  breakMinutes: number;
  /** (salida − entrada) − descansos. 0 si falta entrada o salida. */
  workedMinutes: number;
  /** true si falta entrada y/o salida (para marcarlo en la hoja). */
  incomplete: boolean;
}

/** Un descanso real (break_start→break_end) comparado con el planificado. */
interface BreakDetailDTO {
  id: string;
  employeeId: string;
  employeeName: string | null;
  date: string;
  plannedStart: string | null;
  plannedMinutes: number | null;
  actualStart: string;
  actualEnd: string | null;
  actualMinutes: number | null;
  /** actual − planificado (min). + = empezó tarde / duró de más. */
  startDeviationMin: number | null;
  durationDeviationMin: number | null;
  overbreak: boolean;
  autoClosed: boolean;
}

interface ReviewItemDTO extends ClockEventDTO {
  employeeId: string;
  employeeName: string | null;
  departmentName: string | null;
  branchName: string | null;
  locationId: string | null;
  locationName: string | null;
  locationAddress: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** URL firmada (1h) de la selfie, si hay bucket + foto. */
  photoSignedUrl: string | null;
  /** Minutos de exceso del descanso (anomaly 'overbreak'). null si no aplica. */
  overbreakMinutes: number | null;
}

interface ReviewRow extends ClockEventRow {
  employee_id: string;
  location_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

interface ClockEventDTO {
  id: string;
  type: string;
  source: string;
  occurredAt: string;
  recordedAt: string;
  validationStatus: string;
  anomalyReason: string | null;
  shiftAssignmentId: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  photoUrl: string | null;
  breakLimitMinutes: number | null;
}

const EVENT_COLS =
  'id, type, source, source_metadata, occurred_at, recorded_at, validation_status, anomaly_reason, shift_assignment_id';

const REVIEW_COLS = `${EVENT_COLS}, employee_id, location_id, reviewed_at, review_note`;

/** Minutos desde medianoche del instante `iso` en la zona horaria `tz`. */
function wallMinutesInTz(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

interface ClockEventRow {
  id: string;
  type: string;
  source: string;
  source_metadata: {
    lat?: number;
    lng?: number;
    accuracy?: number;
    photo_url?: string;
    break_limit_minutes?: number | null;
    overbreak_minutes?: number | null;
  } | null;
  occurred_at: string;
  recorded_at: string;
  validation_status: string;
  anomaly_reason: string | null;
  shift_assignment_id: string | null;
}

function toDTO(r: ClockEventRow): ClockEventDTO {
  const m = r.source_metadata ?? {};
  return {
    id: r.id,
    type: r.type,
    source: r.source,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    validationStatus: r.validation_status,
    anomalyReason: r.anomaly_reason ?? null,
    shiftAssignmentId: r.shift_assignment_id ?? null,
    lat: m.lat ?? null,
    lng: m.lng ?? null,
    accuracy: m.accuracy ?? null,
    photoUrl: m.photo_url ?? null,
    breakLimitMinutes: m.break_limit_minutes ?? null,
  };
}

/**
 * TimeclockController — employee attendance (Sprint 2, GPS + selfie).
 *
 * POST /timeclock/events — idempotent punch (by company_id + client_uuid).
 *   The server re-validates GPS against the branch geofence; anomalies are
 *   recorded as `pending_review` (never rejected — an edge clock-in is never
 *   lost). Tenant + employee come from the JWT, never the client.
 * GET  /timeclock/me     — the employee's own punches in a date range.
 */
/** Alta manual de un fichaje por el manager (corrección: ej. el empleado olvidó
 *  marcar). Exige razón. Sin GPS/selfie. */
class ManualClockEventDto {
  @IsString()
  employeeId!: string;

  @IsIn(['in', 'out', 'break_start', 'break_end'])
  type!: string;

  @IsString()
  occurredAt!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  shiftAssignmentId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;
}

/** Edición de la hora de un fichaje existente. Exige razón. */
class EditClockTimeDto {
  @IsString()
  occurredAt!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** Solicitud de corrección (empleado o manager sin permiso). */
class CreateCorrectionRequestDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsIn(['in', 'out', 'break_start', 'break_end'])
  type!: string;

  @IsString()
  occurredAt!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  targetEventId?: string;

  @IsOptional()
  @IsString()
  shiftAssignmentId?: string;
}

class ResolveCorrectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

interface CorrectionRow {
  id: string;
  company_id: string;
  employee_id: string;
  requested_by_employee_id: string | null;
  target_event_id: string | null;
  proposed_type: string;
  proposed_occurred_at: string;
  shift_assignment_id: string | null;
  reason: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolve_note: string | null;
  created_at: string;
}

interface CorrectionRequestDTO {
  id: string;
  employeeId: string;
  employeeName: string | null;
  requestedByEmployeeId: string | null;
  targetEventId: string | null;
  proposedType: string;
  proposedOccurredAt: string;
  shiftAssignmentId: string | null;
  reason: string;
  status: string;
  resolvedAt: string | null;
  resolveNote: string | null;
  createdAt: string;
}

@Controller('timeclock')
export class TimeclockController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly tenantFeatures: TenantFeatureService,
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  @Post('events')
  @HttpCode(HttpStatus.OK)
  async createEvent(
    @Body() dto: CreateClockEventDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<ClockEventDTO> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }

    // Idempotency: a retried offline event returns the original, no dupe.
    const existing = await this.findByClientUuid(companyId, dto.clientUuid);
    if (existing) return toDTO(existing);

    const { geofence, locationId } = await this.resolvePunchGeofence(
      user.employeeId,
      companyId,
      dto.locationId,
    );
    // Los DESCANSOS no se validan por geofence/GPS — no tiene sentido "fuera
    // del área" / "GPS impreciso" en un break. Solo in/out se validan contra la
    // sucursal/locación. (La única anomalía de un break es el overbreak, abajo.)
    const isBreak = dto.type === 'break_start' || dto.type === 'break_end';
    const evaluation = isBreak
      ? { validationStatus: 'valid' as const, anomalyReason: null }
      : evaluateGpsClock(
          { lat: dto.gps.lat, lng: dto.gps.lng, accuracy: dto.gps.accuracy },
          geofence,
        );

    // Overbreak: si el break_end supera el límite del descanso, se marca para
    // revisión del manager (anomaly 'overbreak' + minutos de exceso).
    let validationStatus: string = evaluation.validationStatus;
    let anomalyReason = evaluation.anomalyReason;
    let overbreakMinutes: number | null = null;
    if (dto.type === 'break_end') {
      overbreakMinutes = await this.detectOverbreakMinutes(
        companyId,
        user.employeeId,
        dto.occurredAt,
      );
      if (overbreakMinutes && validationStatus === 'valid') {
        validationStatus = 'pending_review';
        anomalyReason = 'overbreak';
      }
    }

    const { data: inserted, error } = await this.supabase
      .from('time_clock_events')
      .insert({
        company_id: companyId,
        employee_id: user.employeeId,
        shift_assignment_id: dto.shiftAssignmentId ?? null,
        location_id: locationId,
        client_uuid: dto.clientUuid,
        type: dto.type,
        source: 'gps',
        source_metadata: {
          lat: dto.gps.lat,
          lng: dto.gps.lng,
          accuracy: dto.gps.accuracy,
          photo_url: dto.gps.photoUrl ?? null,
          break_limit_minutes: dto.breakLimitMinutes ?? null,
          overbreak_minutes: overbreakMinutes,
        },
        occurred_at: dto.occurredAt,
        validation_status: validationStatus,
        anomaly_reason: anomalyReason,
      })
      .select(EVENT_COLS)
      .single<ClockEventRow>();

    if (error) {
      // Unique violation = a concurrent retry won the race → return the winner.
      if ((error as { code?: string }).code === '23505') {
        const raced = await this.findByClientUuid(companyId, dto.clientUuid);
        if (raced) return toDTO(raced);
      }
      throw new Error(error.message);
    }
    return toDTO(inserted);
  }

  /**
   * Minutos de overbreak de un break_end: busca el break_start abierto del día
   * (con su break_limit_minutes) y devuelve cuánto se pasó del límite. null si
   * no hay límite, no hay descanso abierto, o no se pasó.
   */
  private async detectOverbreakMinutes(
    companyId: string,
    employeeId: string,
    breakEndIso: string,
  ): Promise<number | null> {
    const day = breakEndIso.slice(0, 10);
    const { data } = await this.supabase
      .from('time_clock_events')
      .select('type, occurred_at, source_metadata')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .gte('occurred_at', `${day}T00:00:00.000Z`)
      .order('occurred_at', { ascending: true });
    let openStart: string | null = null;
    let limit: number | null = null;
    for (const e of (data ?? []) as Array<{
      type: string;
      occurred_at: string;
      source_metadata: { break_limit_minutes?: number | null } | null;
    }>) {
      if (e.type === 'break_start') {
        openStart = e.occurred_at;
        limit = e.source_metadata?.break_limit_minutes ?? null;
      } else if (e.type === 'break_end' || e.type === 'out' || e.type === 'in') {
        openStart = null;
        limit = null;
      }
    }
    if (!openStart || limit == null) return null;
    const actualMin = (Date.parse(breakEndIso) - Date.parse(openStart)) / 60000;
    const overrun = Math.round(actualMin - limit);
    return overrun > 0 ? overrun : null;
  }

  @Get('me')
  async myEvents(
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ClockEventDTO[]> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    let q = this.supabase
      .from('time_clock_events')
      .select(EVENT_COLS)
      .eq('company_id', companyId)
      .eq('employee_id', user.employeeId)
      .order('occurred_at', { ascending: false })
      .limit(200);
    if (from) q = q.gte('occurred_at', from);
    if (to) q = q.lte('occurred_at', to);
    const { data, error } = await q.returns<ClockEventRow[]>();
    if (error) throw new Error(error.message);
    return (data ?? []).map(toDTO);
  }

  /**
   * GET /timeclock/review?status=pending_review — cola de revisión del manager.
   * Lista los marcajes del tenant con ese estado (default pending_review),
   * enriquecidos con nombre de empleado/locación + URL firmada de la selfie.
   */
  @Get('review')
  @Requires('schedule:write')
  async reviewQueue(
    @CurrentCompany() companyId: string,
    @Query('status') status = 'pending_review',
  ): Promise<ReviewItemDTO[]> {
    const { data: rows, error } = await this.supabase
      .from('time_clock_events')
      .select(REVIEW_COLS)
      .eq('company_id', companyId)
      .eq('validation_status', status)
      .order('occurred_at', { ascending: false })
      .limit(200)
      .returns<ReviewRow[]>();
    if (error) throw new Error(error.message);
    const list = rows ?? [];
    if (list.length === 0) return [];

    const empIds = [...new Set(list.map((r) => r.employee_id))];
    const locIds = [...new Set(list.map((r) => r.location_id).filter(Boolean))] as string[];
    const [{ data: emps }, { data: locs }] = await Promise.all([
      this.supabase.from('employees').select('id, name, department_id').in('id', empIds),
      locIds.length > 0
        ? this.supabase.from('locations').select('id, name, address').in('id', locIds)
        : Promise.resolve({ data: [] as { id: string; name: string; address: string | null }[] }),
    ]);
    const empInfo = new Map(
      ((emps ?? []) as Array<{ id: string; name: string; department_id: string | null }>).map(
        (e) => [e.id, { name: e.name, departmentId: e.department_id ?? null }],
      ),
    );
    const locInfo = new Map(
      ((locs ?? []) as { id: string; name: string; address: string | null }[]).map((l) => [
        l.id,
        { name: l.name, address: l.address ?? null },
      ]),
    );

    // Departamento + sucursal del empleado (para columnas + export).
    const deptIds = [...new Set([...empInfo.values()].map((e) => e.departmentId).filter(Boolean))] as string[];
    const { data: depts } = deptIds.length
      ? await this.supabase.from('departments').select('id, name, branch_id').in('id', deptIds)
      : { data: [] as Array<{ id: string; name: string; branch_id: string | null }> };
    const deptInfo = new Map(
      (depts ?? []).map((d) => [
        d.id as string,
        { name: d.name as string, branchId: (d.branch_id as string | null) ?? null },
      ]),
    );
    const branchIds = [...new Set([...deptInfo.values()].map((d) => d.branchId).filter(Boolean))] as string[];
    const { data: branches } = branchIds.length
      ? await this.supabase.from('branches').select('id, name').in('id', branchIds)
      : { data: [] as Array<{ id: string; name: string }> };
    const branchName = new Map((branches ?? []).map((b) => [b.id as string, b.name as string]));

    return Promise.all(
      list.map(async (r) => {
        const photoPath = (r.source_metadata ?? {}).photo_url;
        let photoSignedUrl: string | null = null;
        if (photoPath) {
          // Bucket privado — firmamos por 1h. Si el bucket no existe todavía,
          // `error` viene seteado y dejamos la foto en null (graceful).
          const { data: signed } = await this.supabase.storage
            .from('timeclock-photos')
            .createSignedUrl(photoPath, 3600);
          photoSignedUrl = signed?.signedUrl ?? null;
        }
        const emp = empInfo.get(r.employee_id);
        const dept = emp?.departmentId ? deptInfo.get(emp.departmentId) : null;
        return {
          ...toDTO(r),
          employeeId: r.employee_id,
          employeeName: emp?.name ?? null,
          departmentName: dept?.name ?? null,
          branchName: dept?.branchId ? (branchName.get(dept.branchId) ?? null) : null,
          locationId: r.location_id ?? null,
          locationName: r.location_id ? (locInfo.get(r.location_id)?.name ?? null) : null,
          locationAddress: r.location_id ? (locInfo.get(r.location_id)?.address ?? null) : null,
          reviewedAt: r.reviewed_at ?? null,
          reviewNote: r.review_note ?? null,
          photoSignedUrl,
          overbreakMinutes: (r.source_metadata ?? {}).overbreak_minutes ?? null,
        };
      }),
    );
  }

  /**
   * GET /timeclock/timesheet?from=&to=&employeeId=&branchId=&departmentId=
   * Hoja de horas: 1 fila por turno con entrada/salida/breaks/horas trabajadas,
   * derivado de los eventos (matcheados al turno por día + cercanía horaria).
   * Las horas extra (día/semana) las calcula el front con la política del tenant.
   */
  @Get('timesheet')
  @Requires('schedule:write')
  async timesheet(
    @CurrentCompany() companyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeId') employeeId?: string,
    @Query('branchId') branchId?: string,
    @Query('departmentId') departmentId?: string,
  ): Promise<TimesheetRowDTO[]> {
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('from & to (YYYY-MM-DD) are required');
    }

    // 1. Turnos del rango.
    let sq = this.supabase
      .from('shift_assignments')
      .select('id, employee_id, template_id, date, actual_start_time, actual_end_time, location_id')
      .eq('company_id', companyId)
      .gte('date', from)
      .lte('date', to);
    if (employeeId) sq = sq.eq('employee_id', employeeId);
    const { data: shiftsRaw, error: sErr } = await sq.returns<
      Array<{
        id: string;
        employee_id: string;
        template_id: string;
        date: string;
        actual_start_time: string;
        actual_end_time: string;
        location_id: string | null;
      }>
    >();
    if (sErr) throw new Error(sErr.message);
    const shifts = shiftsRaw ?? [];
    if (shifts.length === 0) return [];

    // 2. Eventos del rango (válidos + por revisar; los rechazados no cuentan).
    const empIds = [...new Set(shifts.map((s) => s.employee_id))];
    const { data: events } = await this.supabase
      .from('time_clock_events')
      .select('id, employee_id, type, occurred_at, validation_status, source_metadata')
      .eq('company_id', companyId)
      .in('employee_id', empIds)
      .gte('occurred_at', `${from}T00:00:00.000Z`)
      .lte('occurred_at', `${to}T23:59:59.999Z`)
      .neq('validation_status', 'disputed')
      .order('occurred_at', { ascending: true })
      .returns<
        Array<{
          id: string;
          employee_id: string;
          type: string;
          occurred_at: string;
          source_metadata: Record<string, unknown> | null;
        }>
      >();

    // 3. Lookups: empleado→nombre/depto, depto→nombre/sucursal, sucursal, template, localidad.
    const tplIds = [...new Set(shifts.map((s) => s.template_id))];
    const locIds = [...new Set(shifts.map((s) => s.location_id).filter(Boolean))] as string[];
    const [{ data: emps }, { data: tpls }, { data: locs }] = await Promise.all([
      this.supabase.from('employees').select('id, name, department_id').in('id', empIds),
      this.supabase.from('shift_templates').select('id, name').in('id', tplIds),
      locIds.length
        ? this.supabase.from('locations').select('id, name').in('id', locIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    ]);
    const empInfo = new Map(
      ((emps ?? []) as Array<{ id: string; name: string; department_id: string | null }>).map((e) => [
        e.id,
        { name: e.name, departmentId: e.department_id ?? null },
      ]),
    );
    const tplName = new Map(((tpls ?? []) as Array<{ id: string; name: string }>).map((tp) => [tp.id, tp.name]));
    const locName = new Map(((locs ?? []) as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]));
    const deptIds = [...new Set([...empInfo.values()].map((e) => e.departmentId).filter(Boolean))] as string[];
    const { data: depts } = deptIds.length
      ? await this.supabase.from('departments').select('id, name, branch_id').in('id', deptIds)
      : { data: [] as Array<{ id: string; name: string; branch_id: string | null }> };
    const deptInfo = new Map(
      (depts ?? []).map((d) => [
        d.id as string,
        { name: d.name as string, branchId: (d.branch_id as string | null) ?? null },
      ]),
    );
    const branchIds = [...new Set([...deptInfo.values()].map((d) => d.branchId).filter(Boolean))] as string[];
    const { data: branches } = branchIds.length
      ? await this.supabase.from('branches').select('id, name').in('id', branchIds)
      : { data: [] as Array<{ id: string; name: string }> };
    const branchName = new Map((branches ?? []).map((b) => [b.id as string, b.name as string]));

    // 4. Agrupar eventos por empleado+día y asignar cada uno al turno más cercano.
    const dayOf = (iso: string) => iso.slice(0, 10);
    const shiftsByKey = new Map<string, typeof shifts>();
    for (const s of shifts) {
      const k = `${s.employee_id}|${s.date}`;
      (shiftsByKey.get(k) ?? shiftsByKey.set(k, []).get(k)!).push(s);
    }
    const eventsByShift = new Map<
      string,
      Array<{ id: string; type: string; occurred_at: string; source_metadata: Record<string, unknown> | null }>
    >();
    for (const e of events ?? []) {
      const k = `${e.employee_id}|${dayOf(e.occurred_at)}`;
      const candidates = shiftsByKey.get(k);
      if (!candidates || candidates.length === 0) continue;
      // Turno más cercano por distancia del evento a [start, end].
      const t = Date.parse(e.occurred_at);
      let best = candidates[0]!;
      let bestDist = Infinity;
      for (const s of candidates) {
        const a = Date.parse(s.actual_start_time);
        const b = Date.parse(s.actual_end_time);
        const dist = t < a ? a - t : t > b ? t - b : 0;
        if (dist < bestDist) {
          bestDist = dist;
          best = s;
        }
      }
      (eventsByShift.get(best.id) ?? eventsByShift.set(best.id, []).get(best.id)!).push(e);
    }

    // 5. Armar filas + aplicar filtros de sucursal/depto (post-fetch).
    const rows: TimesheetRowDTO[] = [];
    for (const s of shifts) {
      const emp = empInfo.get(s.employee_id);
      const dept = emp?.departmentId ? deptInfo.get(emp.departmentId) : null;
      const rowBranchId = dept?.branchId ?? null;
      if (departmentId && emp?.departmentId !== departmentId) continue;
      if (branchId && rowBranchId !== branchId) continue;

      const evs = (eventsByShift.get(s.id) ?? []).slice().sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
      const ins = evs.filter((e) => e.type === 'in');
      const outs = evs.filter((e) => e.type === 'out');
      const inEv = ins[0];
      const outEv = outs[outs.length - 1];
      const clockIn = inEv?.occurred_at ?? null;
      const clockOut = outEv?.occurred_at ?? null;
      const clockInId = inEv?.id ?? null;
      const clockOutId = outEv?.id ?? null;
      const correctionReason =
        ((inEv?.source_metadata?.correction_reason as string | undefined) ??
          (outEv?.source_metadata?.correction_reason as string | undefined)) ||
        null;
      let breakCount = 0;
      let breakMs = 0;
      let openBreak: string | null = null;
      for (const e of evs) {
        if (e.type === 'break_start') openBreak = e.occurred_at;
        else if (e.type === 'break_end' && openBreak) {
          breakCount++;
          breakMs += Date.parse(e.occurred_at) - Date.parse(openBreak);
          openBreak = null;
        }
      }
      const workedMs = clockIn && clockOut ? Date.parse(clockOut) - Date.parse(clockIn) - breakMs : 0;
      rows.push({
        shiftId: s.id,
        employeeId: s.employee_id,
        employeeName: emp?.name ?? null,
        date: s.date,
        templateName: tplName.get(s.template_id) ?? '—',
        branchName: rowBranchId ? (branchName.get(rowBranchId) ?? null) : null,
        departmentName: dept?.name ?? null,
        locationName: s.location_id ? (locName.get(s.location_id) ?? null) : null,
        scheduledStart: s.actual_start_time,
        scheduledEnd: s.actual_end_time,
        clockIn,
        clockOut,
        clockInId,
        clockOutId,
        correctionReason,
        breakCount,
        breakMinutes: Math.round(breakMs / 60000),
        workedMinutes: Math.max(0, Math.round(workedMs / 60000)),
        incomplete: !clockIn || !clockOut,
      });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.scheduledStart.localeCompare(b.scheduledStart));
    return rows;
  }

  /**
   * GET /timeclock/breaks?from=&to=&employeeId= — detalle de descansos: empareja
   * break_start→break_end y los compara con el descanso planificado más cercano
   * (plan vs real + desvíos). Útil para revisar overbreaks / descansos fuera de hora.
   */
  @Get('breaks')
  @Requires('schedule:write')
  async breakDetail(
    @CurrentCompany() companyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeId') employeeId?: string,
  ): Promise<BreakDetailDTO[]> {
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('from & to (YYYY-MM-DD) are required');
    }
    const fromIso = `${from}T00:00:00.000Z`;
    const toIso = `${to}T23:59:59.999Z`;

    // 1. Eventos de descanso del rango.
    let eq = this.supabase
      .from('time_clock_events')
      .select('id, employee_id, type, occurred_at, source_metadata')
      .eq('company_id', companyId)
      .in('type', ['break_start', 'break_end'])
      .gte('occurred_at', fromIso)
      .lte('occurred_at', toIso)
      .neq('validation_status', 'disputed')
      .order('occurred_at', { ascending: true });
    if (employeeId) eq = eq.eq('employee_id', employeeId);
    const { data: events, error } = await eq.returns<
      Array<{
        id: string;
        employee_id: string;
        type: string;
        occurred_at: string;
        source_metadata: Record<string, unknown> | null;
      }>
    >();
    if (error) throw new Error(error.message);
    const evs = events ?? [];
    if (evs.length === 0) return [];

    // 2. Emparejar break_start→break_end por empleado (en orden).
    interface Pair {
      id: string;
      employeeId: string;
      start: string;
      end: string | null;
      meta: Record<string, unknown> | null;
    }
    const open = new Map<string, Pair>();
    const pairs: Pair[] = [];
    for (const e of evs) {
      if (e.type === 'break_start') {
        const p: Pair = { id: e.id, employeeId: e.employee_id, start: e.occurred_at, end: null, meta: e.source_metadata };
        open.set(e.employee_id, p);
        pairs.push(p);
      } else if (e.type === 'break_end') {
        const p = open.get(e.employee_id);
        if (p && !p.end) {
          p.end = e.occurred_at;
          p.meta = { ...(p.meta ?? {}), ...(e.source_metadata ?? {}) };
          open.delete(e.employee_id);
        }
      }
    }

    // 3. Descansos planificados del rango (vía assignments).
    const empIds = [...new Set(pairs.map((p) => p.employeeId))];
    const { data: assigns } = await this.supabase
      .from('shift_assignments')
      .select('id, employee_id, date')
      .eq('company_id', companyId)
      .gte('date', from)
      .lte('date', to)
      .in('employee_id', empIds)
      .returns<Array<{ id: string; employee_id: string; date: string }>>();
    const asgEmp = new Map((assigns ?? []).map((a) => [a.id, a.employee_id]));
    const asgIds = (assigns ?? []).map((a) => a.id);
    const { data: planned } = asgIds.length
      ? await this.supabase
          .from('shift_assignment_breaks')
          .select('assignment_id, start_time, end_time')
          .eq('company_id', companyId)
          .in('assignment_id', asgIds)
          .returns<Array<{ assignment_id: string; start_time: string; end_time: string }>>()
      : { data: [] as Array<{ assignment_id: string; start_time: string; end_time: string }> };
    // Planificados por empleado.
    const plannedByEmp = new Map<string, Array<{ start: string; minutes: number }>>();
    for (const pb of planned ?? []) {
      const emp = asgEmp.get(pb.assignment_id);
      if (!emp) continue;
      const minutes = Math.round((Date.parse(pb.end_time) - Date.parse(pb.start_time)) / 60000);
      (plannedByEmp.get(emp) ?? plannedByEmp.set(emp, []).get(emp)!).push({ start: pb.start_time, minutes });
    }

    // 4. Nombres + zona horaria de la sucursal (empleado→depto→sucursal→tz),
    //    para alinear el wall-clock del planificado con el instante real.
    const { data: emps } = await this.supabase
      .from('employees')
      .select('id, name, department_id')
      .in('id', empIds);
    const empName = new Map(
      ((emps ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]),
    );
    const empDept = new Map(
      ((emps ?? []) as Array<{ id: string; department_id: string | null }>).map((e) => [
        e.id,
        e.department_id ?? null,
      ]),
    );
    const deptIds = [...new Set([...empDept.values()].filter(Boolean))] as string[];
    const { data: depts2 } = deptIds.length
      ? await this.supabase.from('departments').select('id, branch_id').in('id', deptIds)
      : { data: [] as Array<{ id: string; branch_id: string | null }> };
    const deptBranch = new Map((depts2 ?? []).map((d) => [d.id as string, (d.branch_id as string | null) ?? null]));
    const branchIds2 = [...new Set([...deptBranch.values()].filter(Boolean))] as string[];
    const { data: branches2 } = branchIds2.length
      ? await this.supabase.from('branches').select('id, timezone').in('id', branchIds2)
      : { data: [] as Array<{ id: string; timezone: string }> };
    const branchTz = new Map((branches2 ?? []).map((b) => [b.id as string, (b.timezone as string) || 'UTC']));
    const tzOf = (empId: string): string => {
      const dept = empDept.get(empId);
      const branch = dept ? deptBranch.get(dept) : null;
      return (branch ? branchTz.get(branch) : null) ?? 'UTC';
    };

    // 5. Armar el detalle, matcheando cada par con el plan más cercano.
    return pairs.map((p) => {
      const actualStartMs = Date.parse(p.start);
      const actualMinutes = p.end ? Math.round((Date.parse(p.end) - actualStartMs) / 60000) : null;
      const candidates = plannedByEmp.get(p.employeeId) ?? [];
      let best: { start: string; minutes: number } | null = null;
      let bestDist = Infinity;
      for (const c of candidates) {
        const dist = Math.abs(Date.parse(c.start) - actualStartMs);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      const plannedMinutes = best?.minutes ?? null;
      // Desvío de inicio comparando wall-clock: el real se convierte a la tz de
      // la sucursal; el planificado se guarda como wall-clock-UTC.
      let startDeviationMin: number | null = null;
      if (best) {
        const actualWall = wallMinutesInTz(p.start, tzOf(p.employeeId));
        const pd = new Date(best.start);
        const plannedWall = pd.getUTCHours() * 60 + pd.getUTCMinutes();
        let dev = actualWall - plannedWall;
        if (dev > 720) dev -= 1440;
        else if (dev < -720) dev += 1440;
        startDeviationMin = dev;
      }
      const durationDeviationMin =
        plannedMinutes != null && actualMinutes != null ? actualMinutes - plannedMinutes : null;
      const overbreakMeta = (p.meta ?? {}).overbreak_minutes as number | undefined;
      return {
        id: p.id,
        employeeId: p.employeeId,
        employeeName: empName.get(p.employeeId) ?? null,
        date: p.start.slice(0, 10),
        plannedStart: best?.start ?? null,
        plannedMinutes,
        actualStart: p.start,
        actualEnd: p.end,
        actualMinutes,
        startDeviationMin,
        durationDeviationMin,
        overbreak: (overbreakMeta ?? 0) > 0 || (durationDeviationMin ?? 0) > 0,
        autoClosed: Boolean((p.meta ?? {}).auto_closed),
      };
    });
  }

  /**
   * PATCH /timeclock/events/:id/review — aprobar/rechazar un marcaje.
   *   approve → validation_status='valid'; reject → 'disputed'.
   * Audita reviewer + timestamp + nota.
   */
  @Patch('events/:id/review')
  @Requires('schedule:write')
  async review(
    @Param('id') id: string,
    @Body() dto: ReviewClockEventDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ ok: true }> {
    const validation_status = dto.decision === 'approve' ? 'valid' : 'disputed';
    const { data, error } = await this.supabase
      .from('time_clock_events')
      .update({
        validation_status,
        reviewed_by: user?.employeeId ?? null,
        reviewed_at: new Date().toISOString(),
        review_note: dto.note ?? null,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Punch ${id} not found`);
    return { ok: true };
  }

  /**
   * POST /timeclock/events/manual — el manager agrega un fichaje que faltó
   * (corrección). Exige razón; sin GPS/selfie. Queda como source='manager',
   * validation_status='valid', con la razón en source_metadata + audit log.
   */
  @Post('events/manual')
  @Requires('timeclock:correct')
  @HttpCode(HttpStatus.CREATED)
  async addManualEvent(
    @Body() dto: ManualClockEventDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<ClockEventDTO> {
    const now = new Date().toISOString();
    const { data: inserted, error } = await this.supabase
      .from('time_clock_events')
      .insert({
        company_id: companyId,
        employee_id: dto.employeeId,
        shift_assignment_id: dto.shiftAssignmentId ?? null,
        location_id: dto.locationId ?? null,
        client_uuid: randomUUID(),
        type: dto.type,
        source: 'manual',
        source_metadata: {
          correction_reason: dto.reason,
          corrected_by: user?.userId ?? null,
          corrected_at: now,
        },
        occurred_at: dto.occurredAt,
        validation_status: 'valid',
        anomaly_reason: null,
      })
      .select(EVENT_COLS)
      .single<ClockEventRow>();
    if (error) throw new Error(error.message);
    await this.audit.log({
      companyId,
      entityType: 'time_clock_event',
      entityId: inserted.id,
      action: 'create',
      changes: {
        type: { before: null, after: dto.type },
        occurred_at: { before: null, after: dto.occurredAt },
        reason: { before: null, after: dto.reason },
      },
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
    return toDTO(inserted);
  }

  /**
   * PATCH /timeclock/events/:id/time — corrige la hora de un fichaje existente.
   * Exige razón. No borra: queda la razón en source_metadata + audit (antes→después).
   */
  @Patch('events/:id/time')
  @Requires('timeclock:correct')
  async editEventTime(
    @Param('id') id: string,
    @Body() dto: EditClockTimeDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<ClockEventDTO> {
    const { data: current } = await this.supabase
      .from('time_clock_events')
      .select('occurred_at, source_metadata')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle<{ occurred_at: string; source_metadata: Record<string, unknown> | null }>();
    if (!current) throw new NotFoundException(`Punch ${id} not found`);
    const before = current.occurred_at;
    const { data: updated, error } = await this.supabase
      .from('time_clock_events')
      .update({
        occurred_at: dto.occurredAt,
        source_metadata: {
          ...(current.source_metadata ?? {}),
          correction_reason: dto.reason,
          corrected_by: user?.userId ?? null,
          corrected_at: new Date().toISOString(),
        },
      })
      .eq('company_id', companyId)
      .eq('id', id)
      .select(EVENT_COLS)
      .single<ClockEventRow>();
    if (error) throw new Error(error.message);
    await this.audit.log({
      companyId,
      entityType: 'time_clock_event',
      entityId: id,
      action: 'update',
      changes: {
        occurred_at: { before, after: dto.occurredAt },
        reason: { before: null, after: dto.reason },
      },
      actorUserId: user?.userId ?? null,
      actorEmployeeId: user?.employeeId ?? null,
    });
    return toDTO(updated);
  }

  // ─── Solicitudes de corrección (F4c) ─────────────────────────────────────

  /** POST /timeclock/correction-requests — crea una solicitud (empleado o manager
   *  sin permiso). Cae como 'pending' a la cola. */
  @Post('correction-requests')
  @HttpCode(HttpStatus.CREATED)
  async createCorrectionRequest(
    @Body() dto: CreateCorrectionRequestDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<CorrectionRequestDTO> {
    const employeeId = dto.employeeId ?? user?.employeeId;
    if (!employeeId) throw new BadRequestException('No employee for the request');
    const { data, error } = await this.supabase
      .from('timeclock_correction_requests')
      .insert({
        company_id: companyId,
        employee_id: employeeId,
        requested_by_employee_id: user?.employeeId ?? null,
        target_event_id: dto.targetEventId ?? null,
        proposed_type: dto.type,
        proposed_occurred_at: dto.occurredAt,
        shift_assignment_id: dto.shiftAssignmentId ?? null,
        reason: dto.reason,
      })
      .select('*')
      .single<CorrectionRow>();
    if (error) throw new Error(error.message);
    return this.toCorrectionDTO(data, null);
  }

  /** GET /timeclock/correction-requests?status=pending — cola para resolver. */
  @Get('correction-requests')
  @Requires('timeclock:correct')
  async listCorrectionRequests(
    @CurrentCompany() companyId: string,
    @Query('status') status = 'pending',
  ): Promise<CorrectionRequestDTO[]> {
    const { data, error } = await this.supabase
      .from('timeclock_correction_requests')
      .select('*')
      .eq('company_id', companyId)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(200)
      .returns<CorrectionRow[]>();
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (!rows.length) return [];
    const empIds = [...new Set(rows.map((r) => r.employee_id))];
    const { data: emps } = await this.supabase.from('employees').select('id, name').in('id', empIds);
    const names = new Map(((emps ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
    return rows.map((r) => this.toCorrectionDTO(r, names.get(r.employee_id) ?? null));
  }

  /** POST /timeclock/correction-requests/:id/apply — aplica (crea/edita el evento)
   *  y marca la solicitud como applied. */
  @Post('correction-requests/:id/apply')
  @Requires('timeclock:correct')
  @HttpCode(HttpStatus.OK)
  async applyCorrectionRequest(
    @Param('id') id: string,
    @Body() dto: ResolveCorrectionDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ ok: true }> {
    const { data: req } = await this.supabase
      .from('timeclock_correction_requests')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle<CorrectionRow>();
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending') throw new BadRequestException('Request already resolved');
    const now = new Date().toISOString();
    const meta = {
      correction_reason: req.reason,
      corrected_by: user?.userId ?? null,
      corrected_at: now,
      from_request: id,
    };

    if (req.target_event_id) {
      const { data: cur } = await this.supabase
        .from('time_clock_events')
        .select('occurred_at, source_metadata')
        .eq('company_id', companyId)
        .eq('id', req.target_event_id)
        .maybeSingle<{ occurred_at: string; source_metadata: Record<string, unknown> | null }>();
      const before = cur?.occurred_at ?? null;
      await this.supabase
        .from('time_clock_events')
        .update({
          occurred_at: req.proposed_occurred_at,
          source_metadata: { ...(cur?.source_metadata ?? {}), ...meta },
        })
        .eq('company_id', companyId)
        .eq('id', req.target_event_id);
      await this.audit.log({
        companyId,
        entityType: 'time_clock_event',
        entityId: req.target_event_id,
        action: 'update',
        changes: {
          occurred_at: { before, after: req.proposed_occurred_at },
          reason: { before: null, after: req.reason },
        },
        actorUserId: user?.userId ?? null,
        actorEmployeeId: user?.employeeId ?? null,
      });
    } else {
      const { data: ins } = await this.supabase
        .from('time_clock_events')
        .insert({
          company_id: companyId,
          employee_id: req.employee_id,
          shift_assignment_id: req.shift_assignment_id ?? null,
          client_uuid: randomUUID(),
          type: req.proposed_type,
          source: 'manual',
          source_metadata: meta,
          occurred_at: req.proposed_occurred_at,
          validation_status: 'valid',
          anomaly_reason: null,
        })
        .select('id')
        .single<{ id: string }>();
      if (ins) {
        await this.audit.log({
          companyId,
          entityType: 'time_clock_event',
          entityId: ins.id,
          action: 'create',
          changes: {
            type: { before: null, after: req.proposed_type },
            occurred_at: { before: null, after: req.proposed_occurred_at },
            reason: { before: null, after: req.reason },
          },
          actorUserId: user?.userId ?? null,
          actorEmployeeId: user?.employeeId ?? null,
        });
      }
    }

    await this.supabase
      .from('timeclock_correction_requests')
      .update({
        status: 'applied',
        resolved_by: user?.userId ?? null,
        resolved_at: now,
        resolve_note: dto.note ?? null,
      })
      .eq('company_id', companyId)
      .eq('id', id);
    return { ok: true };
  }

  /** POST /timeclock/correction-requests/:id/reject — rechaza con nota. */
  @Post('correction-requests/:id/reject')
  @Requires('timeclock:correct')
  @HttpCode(HttpStatus.OK)
  async rejectCorrectionRequest(
    @Param('id') id: string,
    @Body() dto: ResolveCorrectionDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ ok: true }> {
    const { data, error } = await this.supabase
      .from('timeclock_correction_requests')
      .update({
        status: 'rejected',
        resolved_by: user?.userId ?? null,
        resolved_at: new Date().toISOString(),
        resolve_note: dto.note ?? null,
      })
      .eq('company_id', companyId)
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException('Pending request not found');
    return { ok: true };
  }

  private toCorrectionDTO(r: CorrectionRow, employeeName: string | null): CorrectionRequestDTO {
    return {
      id: r.id,
      employeeId: r.employee_id,
      employeeName,
      requestedByEmployeeId: r.requested_by_employee_id ?? null,
      targetEventId: r.target_event_id ?? null,
      proposedType: r.proposed_type,
      proposedOccurredAt: r.proposed_occurred_at,
      shiftAssignmentId: r.shift_assignment_id ?? null,
      reason: r.reason,
      status: r.status,
      resolvedAt: r.resolved_at ?? null,
      resolveNote: r.resolve_note ?? null,
      createdAt: r.created_at,
    };
  }

  private async findByClientUuid(
    companyId: string,
    clientUuid: string,
  ): Promise<ClockEventRow | null> {
    const { data } = await this.supabase
      .from('time_clock_events')
      .select(EVENT_COLS)
      .eq('company_id', companyId)
      .eq('client_uuid', clientUuid)
      .maybeSingle<ClockEventRow>();
    return data ?? null;
  }

  /**
   * Resolves the geofence to validate the punch against:
   *  - if the 'locations' feature is on AND a locationId is given → validate it
   *    belongs to the employee's allowed set + active, use its geofence, and
   *    stamp location_id on the event.
   *  - otherwise → the branch geofence (default behavior, no location stamped).
   */
  private async resolvePunchGeofence(
    employeeId: string,
    companyId: string,
    locationId?: string,
  ): Promise<{ geofence: GeofenceConfig | null; locationId: string | null }> {
    if (locationId && (await this.tenantFeatures.isEnabled(companyId, 'locations'))) {
      const { data: allowed } = await this.supabase
        .from('employee_locations')
        .select('location_id')
        .eq('employee_id', employeeId)
        .eq('company_id', companyId)
        .eq('location_id', locationId)
        .maybeSingle();
      if (!allowed) {
        throw new ForbiddenException('This location is not allowed for the employee');
      }
      const { data: loc } = await this.supabase
        .from('locations')
        .select('geofence_lat, geofence_lng, geofence_radius_m, is_active')
        .eq('id', locationId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (loc && loc.is_active) {
        return {
          geofence: {
            lat: loc.geofence_lat as number,
            lng: loc.geofence_lng as number,
            radiusM: loc.geofence_radius_m as number,
          },
          locationId,
        };
      }
    }
    return { geofence: await this.resolveGeofence(employeeId, companyId), locationId: null };
  }

  /** employee → department → branch geofence (null if not fully configured). */
  private async resolveGeofence(
    employeeId: string,
    companyId: string,
  ): Promise<GeofenceConfig | null> {
    const { data: emp } = await this.supabase
      .from('employees')
      .select('department_id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    const departmentId = (emp?.department_id as string | null) ?? null;
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
      .select('geofence_lat, geofence_lng, geofence_radius_m')
      .eq('id', branchId)
      .eq('company_id', companyId)
      .maybeSingle();
    const lat = branch?.geofence_lat as number | null;
    const lng = branch?.geofence_lng as number | null;
    const radiusM = branch?.geofence_radius_m as number | null;
    if (lat == null || lng == null || radiusM == null) return null;
    return { lat, lng, radiusM };
  }
}
