import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { weekStartIso, type WeekStartsOn } from '../shared/week';

/**
 * Thrown when a `generate_schedule` request collides with another
 * in-flight generation for the same `(companyId, weekStart)`. Callers
 * (REST controller / WhatsApp router) catch this and translate to a
 * 409 / i18n message respectively.
 */
export class ScheduleGenerationLockedException extends Error {
  constructor(
    public readonly companyId: string,
    public readonly weekStart: string,
    public readonly acquiredAt: string,
    public readonly acquiredBy: string | null,
  ) {
    super(
      `Schedule generation already in progress for company=${companyId} week=${weekStart} (since ${acquiredAt})`,
    );
    this.name = 'ScheduleGenerationLockedException';
  }
}

/**
 * ScheduleGenerationLockService
 *
 * Lock por `(companyId, weekStart)` para el path síncrono de
 * `generate_schedule`. Persiste en `schedule_generation_locks`
 * (PK = company_id, week_start). Política: rechazar el segundo request
 * mientras hay uno activo; lock stale > STALE_AFTER_MS se override.
 *
 * Cuando entre pg-boss (Fase 1), `singletonKey` cubre lo mismo del lado
 * async; este servicio sigue protegiendo cualquier dispatch sync que
 * todavía exista durante la transición.
 */
@Injectable()
export class ScheduleGenerationLockService {
  private readonly logger = new Logger(ScheduleGenerationLockService.name);
  /** Locks held longer than this are considered stale (orchestrator crash etc.). */
  static readonly STALE_AFTER_MS = 5 * 60 * 1000;

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Normaliza un weekStart al primer día de la semana del tenant
   * (lunes o domingo según `companies.week_starts_on`).
   *
   * El lock-key DB es (company_id, week_start) y debe ser idempotente
   * aunque el caller pase un día arbitrario dentro de la semana.
   */
  static toWeekStart(weekStart: string, weekStartsOn: WeekStartsOn): string {
    return weekStartIso(new Date(`${weekStart}T00:00:00.000Z`), weekStartsOn);
  }

  /**
   * Toma el lock o lanza `ScheduleGenerationLockedException`. Si el
   * lock existente está stale (acquired_at > STALE_AFTER_MS atrás),
   * lo override y procede.
   */
  async acquire(
    companyId: string,
    weekStart: string,
    acquiredBy: string,
    weekStartsOn: WeekStartsOn,
  ): Promise<void> {
    const normalized = ScheduleGenerationLockService.toWeekStart(
      weekStart,
      weekStartsOn,
    );

    const { error: insertError } = await this.supabase
      .from('schedule_generation_locks')
      .insert({
        company_id: companyId,
        week_start: normalized,
        acquired_by: acquiredBy,
      });

    if (!insertError) {
      this.logger.log(
        `Lock acquired company=${companyId} week=${normalized} by=${acquiredBy}`,
      );
      return;
    }

    // Conflict (PK violation) → revisar si el lock existente está stale.
    const { data: existing } = await this.supabase
      .from('schedule_generation_locks')
      .select('acquired_at, acquired_by')
      .eq('company_id', companyId)
      .eq('week_start', normalized)
      .maybeSingle();

    if (!existing) {
      // Race rarísima: la fila se borró entre el insert fallido y el
      // select. Reintentar el insert una vez.
      const { error: retryError } = await this.supabase
        .from('schedule_generation_locks')
        .insert({
          company_id: companyId,
          week_start: normalized,
          acquired_by: acquiredBy,
        });
      if (retryError) {
        throw new ScheduleGenerationLockedException(
          companyId,
          normalized,
          new Date().toISOString(),
          null,
        );
      }
      return;
    }

    const ageMs = Date.now() - new Date(existing.acquired_at).getTime();
    if (ageMs < ScheduleGenerationLockService.STALE_AFTER_MS) {
      throw new ScheduleGenerationLockedException(
        companyId,
        normalized,
        existing.acquired_at,
        existing.acquired_by ?? null,
      );
    }

    // Stale → override (asumimos que el holder anterior crasheó).
    this.logger.warn(
      `Overriding stale lock company=${companyId} week=${normalized} ` +
        `(held ${Math.round(ageMs / 1000)}s by ${existing.acquired_by ?? 'unknown'}, reassigning to ${acquiredBy})`,
    );
    await this.supabase
      .from('schedule_generation_locks')
      .update({
        acquired_at: new Date().toISOString(),
        acquired_by: acquiredBy,
      })
      .eq('company_id', companyId)
      .eq('week_start', normalized);
  }

  /**
   * Libera el lock. Idempotente — si la fila ya no existe, no falla.
   * Errores se loguean pero no se propagan: la liberación nunca debe
   * romper el flow del caller.
   *
   * `expectedAcquiredBy` (opcional) — si se pasa, solo borra si el
   * lock fue adquirido por ese token. Evita la race donde el handler
   * de un job cancelado libera el lock de un job NUEVO (mismo
   * company, week) que ya lo tomó. Pasar el `jobId` o un UUID único
   * por intento. Sin token: borra incondicional (legacy path).
   */
  async release(
    companyId: string,
    weekStart: string,
    weekStartsOn: WeekStartsOn,
    expectedAcquiredBy?: string,
  ): Promise<void> {
    const normalized = ScheduleGenerationLockService.toWeekStart(
      weekStart,
      weekStartsOn,
    );
    let query = this.supabase
      .from('schedule_generation_locks')
      .delete()
      .eq('company_id', companyId)
      .eq('week_start', normalized);
    if (expectedAcquiredBy !== undefined) {
      query = query.eq('acquired_by', expectedAcquiredBy);
    }
    const { error } = await query;
    if (error) {
      this.logger.warn(
        `Failed to release lock company=${companyId} week=${normalized}: ${error.message}`,
      );
      return;
    }
    this.logger.log(
      `Lock released company=${companyId} week=${normalized}` +
        (expectedAcquiredBy ? ` (token=${expectedAcquiredBy})` : ''),
    );
  }
}
