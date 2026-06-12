import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resumen de un turno para dar contexto a las cards de Approvals
 * (qué día, qué horario, qué rol). Espejo de `ApprovalShiftRef` en
 * `@ai-scheduling/shared`.
 */
export interface ApprovalShiftRef {
  /** YYYY-MM-DD (fecha lógica del slot). */
  date: string;
  /** ISO datetime UTC — inicio real. */
  start: string;
  /** ISO datetime UTC — fin real. */
  end: string;
  /** Nombre del template (rol) o null si el template fue borrado. */
  role: string | null;
}

interface AssignmentRow {
  id: string;
  employee_id: string;
  date: string;
  actual_start_time: string;
  actual_end_time: string;
  template_id: string | null;
}

/**
 * Fuente única para enriquecer solicitudes (swap, day-off, absence) con el
 * turno al que aplican. Lo usan los 3 controllers en vez de repetir la query
 * de `shift_assignments` + template en cada uno.
 */
@Injectable()
export class ApprovalShiftEnricher {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /** assignmentId → turno puntual. */
  async byAssignmentIds(
    companyId: string,
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, ApprovalShiftRef>> {
    const clean = [...new Set(ids.filter((id): id is string => !!id))];
    const out = new Map<string, ApprovalShiftRef>();
    if (!clean.length) return out;
    const rows = await this.fetch(companyId, (q) => q.in('id', clean));
    const names = await this.templateNames(companyId, rows);
    for (const r of rows) out.set(r.id, this.toRef(r, names));
    return out;
  }

  /**
   * (employeeId, date) → primer turno de ese empleado ese día, o ausente si no
   * tiene. Key del Map = `${employeeId}|${date}`. Útil para day-off (¿qué turno
   * pierde?) y para el target de un swap (¿tiene turno ese día?).
   */
  async byEmployeeDates(
    companyId: string,
    pairs: Array<{ employeeId: string; date: string }>,
  ): Promise<Map<string, ApprovalShiftRef>> {
    const out = new Map<string, ApprovalShiftRef>();
    const empIds = [...new Set(pairs.map((p) => p.employeeId))];
    const dates = [...new Set(pairs.map((p) => p.date))];
    if (!empIds.length || !dates.length) return out;
    const rows = await this.fetch(companyId, (q) =>
      q.in('employee_id', empIds).in('date', dates),
    );
    const names = await this.templateNames(companyId, rows);
    // Primer turno por (employee, date): el más temprano del día.
    rows.sort((a, b) => a.actual_start_time.localeCompare(b.actual_start_time));
    for (const r of rows) {
      const key = `${r.employee_id}|${r.date}`;
      if (!out.has(key)) out.set(key, this.toRef(r, names));
    }
    return out;
  }

  private async fetch(
    companyId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    narrow: (q: any) => any,
  ): Promise<AssignmentRow[]> {
    const base = this.supabase
      .from('shift_assignments')
      .select('id, employee_id, date, actual_start_time, actual_end_time, template_id')
      .eq('company_id', companyId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await narrow(base);
    if (error) throw new Error(error.message);
    return (data ?? []) as AssignmentRow[];
  }

  private async templateNames(
    companyId: string,
    rows: AssignmentRow[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.map((r) => r.template_id).filter((id): id is string => !!id)),
    ];
    if (!ids.length) return new Map();
    const { data } = await this.supabase
      .from('shift_templates')
      .select('id, name')
      .eq('company_id', companyId)
      .in('id', ids);
    return new Map(
      ((data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]),
    );
  }

  private toRef(r: AssignmentRow, names: Map<string, string>): ApprovalShiftRef {
    return {
      date: r.date,
      // Normalizar a ISO UTC limpio (igual que la agenda) — el valor crudo de
      // Postgres lo parsea distinto Hermes (RN) y desfasa las horas.
      start: new Date(r.actual_start_time).toISOString(),
      end: new Date(r.actual_end_time).toISOString(),
      role: r.template_id ? names.get(r.template_id) ?? null : null,
    };
  }
}
