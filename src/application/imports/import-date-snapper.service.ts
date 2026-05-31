import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ImportPayload } from '../../domain/imports/import-payload.types';

/**
 * ImportDateSnapper — remapea las fechas de un ImportPayload a la semana
 * actual del tenant cuando están "obviamente fuera" del presente.
 *
 * Aplica a las 3 vías (upload AI, plantillas Excel, paste JSON) para
 * cubrir el caso típico en que el archivo / output del LLM viene con
 * fechas sample (mayo 2035 en plantillas de Smartsheet, p.ej.) y el
 * owner espera ver los turnos en SU semana, no en 2035.
 *
 * Threshold: solo se aplica el snap si la fecha mínima del payload
 * está a más de THRESHOLD_DAYS del "hoy" del server. Eso preserva los
 * imports legítimos de "esta semana" / "próxima semana" / "histórico
 * reciente" sin remapearlos.
 *
 * El snap preserva multi-semana: si el payload tiene Lun W1 y Lun W2,
 * después del snap quedan en Lun semanaActual y Lun semanaActual+1.
 * El offset es el delta entre la semana del archivo y la semana actual.
 *
 * Populamos `sourceMetadata.originalDateRange` + `snappedDateRange`
 * en ambos casos (snap aplicado o no) para que la UI muestre el banner
 * con el contexto correcto.
 */
@Injectable()
export class ImportDateSnapperService {
  private readonly logger = new Logger(ImportDateSnapperService.name);
  /** Distancia (en días) entre minDate y hoy a partir de la cual se
   *  considera que el archivo NO es del "ahora del owner" y se remapea.
   *  60 días = ~2 meses cubre planificación corta de pyme sin pisar
   *  los imports de sample data lejana (2035, históricos de >1 año). */
  private readonly THRESHOLD_DAYS = 60;

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async snapIfNeeded(
    payload: ImportPayload,
    companyId: string,
  ): Promise<ImportPayload> {
    const shifts = payload.data.shifts ?? [];
    const timeOff = payload.data.timeOff ?? [];
    if (shifts.length === 0 && timeOff.length === 0) {
      return payload;
    }

    const allDates: string[] = [
      ...shifts.map((s) => s.date),
      ...timeOff.flatMap((t) => [t.startDate, t.endDate]),
    ].filter(
      (d): d is string =>
        typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d),
    );
    if (allDates.length === 0) {
      return payload;
    }

    const sorted = [...allDates].sort();
    const originalFrom = sorted[0];
    const originalTo = sorted[sorted.length - 1];

    // Threshold check: ¿la fecha mínima está cerca de hoy?
    const minDateMs = new Date(`${originalFrom}T00:00:00Z`).getTime();
    const distanceDays = Math.abs(
      (minDateMs - Date.now()) / (24 * 3600 * 1000),
    );
    if (distanceDays <= this.THRESHOLD_DAYS) {
      // Fechas cercanas — el owner sabe lo que está importando.
      // Solo populamos los rangos sin remapear.
      return {
        ...payload,
        sourceMetadata: {
          ...payload.sourceMetadata,
          originalDateRange: { from: originalFrom, to: originalTo },
          snappedDateRange: { from: originalFrom, to: originalTo },
        },
      };
    }

    const weekStartsOn = await this.getCompanyWeekStartsOn(companyId);
    const sourceWeekStart = this.weekStartOf(
      new Date(`${originalFrom}T00:00:00Z`),
      weekStartsOn,
    );
    const targetWeekStart = this.weekStartOf(new Date(), weekStartsOn);
    const offsetDays = Math.round(
      (targetWeekStart.getTime() - sourceWeekStart.getTime()) /
        (24 * 3600 * 1000),
    );

    if (offsetDays === 0) {
      return {
        ...payload,
        sourceMetadata: {
          ...payload.sourceMetadata,
          originalDateRange: { from: originalFrom, to: originalTo },
          snappedDateRange: { from: originalFrom, to: originalTo },
        },
      };
    }

    this.logger.log(
      `Snap dates (distance=${Math.round(distanceDays)}d): ${originalFrom} → target week ${this.toIso(targetWeekStart)}, offset=${offsetDays}d`,
    );

    const shiftedShifts = shifts.map((s) => ({
      ...s,
      date: this.shiftIsoDate(s.date, offsetDays),
    }));
    const shiftedTimeOff = timeOff.map((t) => ({
      ...t,
      startDate: this.shiftIsoDate(t.startDate, offsetDays),
      endDate: this.shiftIsoDate(t.endDate, offsetDays),
    }));

    return {
      ...payload,
      sourceMetadata: {
        ...payload.sourceMetadata,
        originalDateRange: { from: originalFrom, to: originalTo },
        snappedDateRange: {
          from: this.shiftIsoDate(originalFrom, offsetDays),
          to: this.shiftIsoDate(originalTo, offsetDays),
        },
      },
      data: {
        ...payload.data,
        shifts: shiftedShifts,
        timeOff: shiftedTimeOff,
      },
    };
  }

  private async getCompanyWeekStartsOn(
    companyId: string,
  ): Promise<'sunday' | 'monday'> {
    const { data } = await this.supabase
      .from('companies')
      .select('week_starts_on')
      .eq('id', companyId)
      .maybeSingle();
    const value = (data?.week_starts_on as string | undefined) ?? 'monday';
    return value === 'sunday' ? 'sunday' : 'monday';
  }

  private weekStartOf(d: Date, weekStartsOn: 'sunday' | 'monday'): Date {
    const day = d.getUTCDay();
    const offset = weekStartsOn === 'sunday' ? day : (day + 6) % 7;
    const start = new Date(d);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - offset);
    return start;
  }

  private shiftIsoDate(iso: string, offsetDays: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return this.toIso(d);
  }

  private toIso(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
