import { Controller, Get, Inject } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';

interface PendingCountsDTO {
  corrections: number;
  swaps: number;
  dayoffs: number;
  incidents: number;
  absences: number;
  preferences: number;
  /** Suma de lo accionable (badge de la card Aprobaciones). */
  total: number;
}

/**
 * ApprovalsController — contadores de pendientes para el panel del manager
 * (móvil + web). Una sola llamada para la card "Aprobaciones".
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Get('pending-counts')
  @Requires('schedule:write')
  async pendingCounts(
    @CurrentCompany() companyId: string,
  ): Promise<PendingCountsDTO> {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const head = (table: string) =>
      this.supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId);

    const [corrections, swaps, dayoffs, incidents, absences, preferences] =
      await Promise.all([
        head('timeclock_correction_requests').eq('status', 'pending'),
        head('shift_swap_requests')
          .is('deleted_at', null)
          .eq('status', 'pending'),
        head('day_off_requests').is('deleted_at', null).eq('status', 'pending'),
        // Reportes libres del empleado pendientes de acción del manager.
        // (El estado 'PENDING' no existe en el enum — era un bug, nunca contaba.)
        head('incidents').is('deleted_at', null).eq('status', 'reported'),
        head('absence_reports')
          .is('deleted_at', null)
          .gte('reported_at', since),
        // Preferencias sin accionar (el manager las convierte en regla o las
        // resuelve manual → soft-delete). Activas = pendientes.
        head('shift_preferences').is('deleted_at', null),
      ]);

    const c = corrections.count ?? 0;
    const s = swaps.count ?? 0;
    const d = dayoffs.count ?? 0;
    const i = incidents.count ?? 0;
    const a = absences.count ?? 0;
    const p = preferences.count ?? 0;
    return {
      corrections: c,
      swaps: s,
      dayoffs: d,
      incidents: i,
      absences: a,
      preferences: p,
      // `total` (badge principal) NO incluye preferencias: el móvil no tiene
      // pantalla de prefs y las infla sin dónde resolverlas. El badge de prefs
      // vive aparte en el sidebar web.
      total: c + s + d + i,
    };
  }
}
