import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  WhatsappPendingClarification,
  type PersistedSuggestion,
  type WhatsappTargetKind,
} from '../../domain/aggregates/whatsapp-pending-clarification.aggregate';
import type { IWhatsappPendingClarificationRepository } from '../../domain/repositories/whatsapp-pending-clarification.repository';

interface PendingRow {
  id: string;
  employee_id: string;
  company_id: string;
  target_kind: WhatsappTargetKind;
  original_text: string;
  suggestions: PersistedSuggestion[];
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

@Injectable()
export class SupabaseWhatsappPendingClarificationRepository implements IWhatsappPendingClarificationRepository {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(entry: WhatsappPendingClarification): Promise<void> {
    const snap = entry.toSnapshot();
    const { error } = await this.supabase
      .from('whatsapp_pending_clarifications')
      .upsert({
        id: snap.id,
        employee_id: snap.employeeId,
        company_id: snap.companyId,
        target_kind: snap.targetKind,
        original_text: snap.originalText,
        suggestions: snap.suggestions,
        expires_at: snap.expiresAt.toISOString(),
        created_at: snap.createdAt.toISOString(),
        resolved_at: snap.resolvedAt?.toISOString() ?? null,
      });
    if (error) {
      throw new Error(
        `WhatsappPendingClarificationRepository.save: ${error.message}`,
      );
    }
  }

  async findActiveByEmployee(
    employeeId: string,
    companyId: string,
  ): Promise<WhatsappPendingClarification | null> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('whatsapp_pending_clarifications')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .is('resolved_at', null)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(
        `WhatsappPendingClarificationRepository.findActiveByEmployee: ${error.message}`,
      );
    }
    return data ? this.toDomain(data as PendingRow) : null;
  }

  async findById(
    id: string,
    companyId: string,
  ): Promise<WhatsappPendingClarification | null> {
    const { data, error } = await this.supabase
      .from('whatsapp_pending_clarifications')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `WhatsappPendingClarificationRepository.findById: ${error.message}`,
      );
    }
    return data ? this.toDomain(data as PendingRow) : null;
  }

  async markResolved(id: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from('whatsapp_pending_clarifications')
      .update({ resolved_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('resolved_at', null);
    if (error) {
      throw new Error(
        `WhatsappPendingClarificationRepository.markResolved: ${error.message}`,
      );
    }
  }

  private toDomain(row: PendingRow): WhatsappPendingClarification {
    return WhatsappPendingClarification.fromPersistence({
      id: row.id,
      employeeId: row.employee_id,
      companyId: row.company_id,
      targetKind: row.target_kind,
      originalText: row.original_text,
      suggestions: row.suggestions ?? [],
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    });
  }
}
