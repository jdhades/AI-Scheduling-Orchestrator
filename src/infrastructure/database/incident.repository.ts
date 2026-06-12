import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from '../../domain/aggregates/incident.aggregate';

export interface IncidentFilter {
  employeeId?: string;
  status?: IncidentStatus | IncidentStatus[];
}

/**
 * IncidentRepository — Supabase-backed persistence for the Incident
 * aggregate. Reemplaza el stub in-memory previo.
 *
 * Se deja el nombre de clase original (sin ISomething port) para no
 * romper los imports de los handlers existentes. Si el proyecto pasa a
 * un patrón port/adapter estricto más adelante, extraer el contrato
 * mueve aquí.
 */
@Injectable()
export class IncidentRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(incident: Incident): Promise<void> {
    const row = {
      id: incident.id,
      company_id: incident.companyId,
      employee_id: incident.employeeId,
      type: incident.type,
      status: incident.status,
      evidence_url: incident.evidenceUrl,
      message: incident.message,
      ocr_text: incident.ocrText,
      ocr_confidence: incident.ocrConfidence,
      validated: incident.validated,
      start_date: incident.startDate
        ? incident.startDate.toISOString().split('T')[0]
        : null,
      end_date: incident.endDate
        ? incident.endDate.toISOString().split('T')[0]
        : null,
      created_at: incident.createdAt.toISOString(),
      updated_at: incident.updatedAt.toISOString(),
    };
    const { error } = await this.supabase.from('incidents').upsert(row);
    if (error) throw new Error(`IncidentRepository.save: ${error.message}`);
  }

  async findById(id: string, companyId?: string): Promise<Incident | null> {
    let q = this.supabase.from('incidents').select('*').eq('id', id);
    if (companyId) q = q.eq('company_id', companyId);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`IncidentRepository.findById: ${error.message}`);
    return data ? this.toDomain(data) : null;
  }

  async findAllByCompany(
    companyId: string,
    filter?: IncidentFilter,
  ): Promise<Incident[]> {
    let q = this.supabase
      .from('incidents')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (filter?.employeeId) q = q.eq('employee_id', filter.employeeId);
    if (filter?.status) {
      q = Array.isArray(filter.status)
        ? q.in('status', filter.status)
        : q.eq('status', filter.status);
    }
    const { data, error } = await q;
    if (error)
      throw new Error(`IncidentRepository.findAllByCompany: ${error.message}`);
    return (data ?? []).map((r) => this.toDomain(r));
  }

  private toDomain(row: Record<string, unknown>): Incident {
    return Incident.fromPersistence({
      id: row.id as string,
      companyId: row.company_id as string,
      employeeId: row.employee_id as string,
      type: row.type as IncidentType,
      status: row.status as IncidentStatus,
      evidenceUrl: (row.evidence_url as string) ?? null,
      message: (row.message as string) ?? null,
      ocrText: (row.ocr_text as string) ?? null,
      ocrConfidence:
        row.ocr_confidence != null ? Number(row.ocr_confidence) : null,
      validated: Boolean(row.validated ?? false),
      startDate: row.start_date ? new Date(row.start_date as string) : null,
      endDate: row.end_date ? new Date(row.end_date as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });
  }
}
