import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  evaluateGpsClock,
  type GeofenceConfig,
} from '../../domain/services/timeclock-evaluation';
import { TenantFeatureService } from '../../domain/services/tenant-feature.service';
import { CreateClockEventDto } from '../dtos/create-clock-event.dto';

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
}

const EVENT_COLS =
  'id, type, source, source_metadata, occurred_at, recorded_at, validation_status, anomaly_reason, shift_assignment_id';

interface ClockEventRow {
  id: string;
  type: string;
  source: string;
  source_metadata: { lat?: number; lng?: number; accuracy?: number; photo_url?: string } | null;
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
@Controller('timeclock')
export class TimeclockController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly tenantFeatures: TenantFeatureService,
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
    const evaluation = evaluateGpsClock(
      { lat: dto.gps.lat, lng: dto.gps.lng, accuracy: dto.gps.accuracy },
      geofence,
    );

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
        },
        occurred_at: dto.occurredAt,
        validation_status: evaluation.validationStatus,
        anomaly_reason: evaluation.anomalyReason,
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
