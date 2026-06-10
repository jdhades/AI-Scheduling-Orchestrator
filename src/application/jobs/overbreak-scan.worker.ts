import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import { PgBossService } from '../../infrastructure/queue/pg-boss.service';
import { JOB_TIMECLOCK_OVERBREAK_SCAN } from '../../infrastructure/queue/job-names';

/** Minutos de gracia tras el límite antes de auto-cerrar. Operativo, no negocio. */
const GRACE_MINUTES = Number(process.env.OVERBREAK_GRACE_MINUTES ?? 5);

interface BreakStartRow {
  id: string;
  company_id: string;
  employee_id: string;
  occurred_at: string;
  source_metadata: { break_limit_minutes?: number | null } | null;
}

/**
 * Job recurrente (cron `*​/5 * * * *`): cierra los descansos que pasaron su
 * límite y el empleado NUNCA fichó la vuelta. Inserta un break_end `auto` en
 * (inicio + límite), marcado overbreak + pending_review, para que el descanso
 * no quede abierto para siempre y el manager lo vea. Idempotente vía client_uuid
 * `auto-overbreak-<break_start_id>` (un solo auto-cierre por descanso).
 */
@Injectable()
export class OverbreakScanWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(OverbreakScanWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.ENABLE_WORKERS === 'false') return;
    if (!this.pgBoss.isEnabled()) {
      this.logger.warn('pg-boss disabled — OverbreakScanWorker NOT registered');
      return;
    }
    const boss = this.pgBoss.getInstance();
    await boss.work(JOB_TIMECLOCK_OVERBREAK_SCAN, { batchSize: 1 }, async () => {
      await this.scan();
    });
    this.logger.log(`OverbreakScanWorker ready: ${JOB_TIMECLOCK_OVERBREAK_SCAN}`);
  }

  private async scan(): Promise<void> {
    const now = Date.now();
    const since = new Date(now - 24 * 3600 * 1000).toISOString();
    const { data: starts } = await this.supabase
      .from('time_clock_events')
      .select('id, company_id, employee_id, occurred_at, source_metadata')
      .eq('type', 'break_start')
      .gte('occurred_at', since)
      .returns<BreakStartRow[]>();

    // Candidatos: con límite y pasados (límite + gracia) — filtro en código
    // porque el límite es por-fila (vive en el JSON metadata).
    const candidates = (starts ?? []).filter((s) => {
      const limit = s.source_metadata?.break_limit_minutes;
      return limit != null && now - Date.parse(s.occurred_at) > (limit + GRACE_MINUTES) * 60000;
    });
    if (candidates.length === 0) return;

    // ¿Ya se cerró? Un solo fetch de eventos de cierre para esos empleados.
    const empIds = [...new Set(candidates.map((c) => c.employee_id))];
    const earliest = candidates.reduce(
      (min, c) => (c.occurred_at < min ? c.occurred_at : min),
      candidates[0]!.occurred_at,
    );
    const { data: closers } = await this.supabase
      .from('time_clock_events')
      .select('employee_id, occurred_at')
      .in('employee_id', empIds)
      .in('type', ['break_end', 'out', 'in'])
      .gte('occurred_at', earliest)
      .returns<Array<{ employee_id: string; occurred_at: string }>>();
    const closersByEmp = new Map<string, string[]>();
    for (const c of closers ?? []) {
      const arr = closersByEmp.get(c.employee_id) ?? [];
      arr.push(c.occurred_at);
      closersByEmp.set(c.employee_id, arr);
    }

    let closed = 0;
    for (const cand of candidates) {
      const stillOpen = !(closersByEmp.get(cand.employee_id) ?? []).some(
        (t) => t > cand.occurred_at,
      );
      if (!stillOpen) continue;
      const limit = cand.source_metadata!.break_limit_minutes!;
      const autoEndMs = Date.parse(cand.occurred_at) + limit * 60000;
      const overrun = Math.round((now - autoEndMs) / 60000);
      const { error } = await this.supabase.from('time_clock_events').insert({
        company_id: cand.company_id,
        employee_id: cand.employee_id,
        client_uuid: `auto-overbreak-${cand.id}`,
        type: 'break_end',
        source: 'auto',
        source_metadata: {
          break_limit_minutes: limit,
          overbreak_minutes: overrun,
          auto_closed: true,
        },
        occurred_at: new Date(autoEndMs).toISOString(),
        validation_status: 'pending_review',
        anomaly_reason: 'overbreak',
      });
      // Unique violation (ya auto-cerrado en una corrida previa) → ignorar.
      if (!error) closed++;
    }
    if (closed > 0) this.logger.log(`Auto-closed ${closed} overbreak(s)`);
  }
}
