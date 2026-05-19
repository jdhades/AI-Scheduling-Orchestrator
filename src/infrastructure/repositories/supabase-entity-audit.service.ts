import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IEntityAuditService,
  LogParams,
} from '../../domain/audit/entity-audit.service';
import type {
  EntityAuditEntry,
  EntityType,
} from '../../domain/audit/entity-audit.types';

interface AuditRow {
  id: string;
  company_id: string;
  entity_type: EntityType;
  entity_id: string;
  action: 'create' | 'update' | 'delete';
  changes: Record<string, { before: unknown; after: unknown }>;
  actor_user_id: string | null;
  actor_employee_id: string | null;
  changed_at: string;
}

@Injectable()
export class SupabaseEntityAuditService implements IEntityAuditService {
  private readonly logger = new Logger(SupabaseEntityAuditService.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async log(params: LogParams): Promise<void> {
    if (params.action === 'update' && Object.keys(params.changes).length === 0) {
      return;
    }
    const { error } = await this.supabase.from('entity_audit_log').insert({
      id: randomUUID(),
      company_id: params.companyId,
      entity_type: params.entityType,
      entity_id: params.entityId,
      action: params.action,
      changes: params.changes,
      actor_user_id: params.actorUserId ?? null,
      actor_employee_id: params.actorEmployeeId ?? null,
    });
    if (error) {
      // No tiramos — un fallo de audit no debe romper el flujo
      // principal del controller. Lo dejamos en el log para
      // que aparezca en observabilidad.
      this.logger.error(
        `Failed to log audit entry for ${params.entityType}/${params.entityId}: ${error.message}`,
      );
    }
  }

  async list(
    companyId: string,
    entityType: EntityType,
    entityId: string,
  ): Promise<EntityAuditEntry[]> {
    const { data, error } = await this.supabase
      .from('entity_audit_log')
      .select('*')
      .eq('company_id', companyId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('changed_at', { ascending: false });
    if (error) {
      throw new Error(`EntityAuditService.list: ${error.message}`);
    }
    return (data ?? []).map((r) => this.rowToEntry(r as AuditRow));
  }

  private rowToEntry(r: AuditRow): EntityAuditEntry {
    return {
      id: r.id,
      companyId: r.company_id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      action: r.action,
      changes: r.changes ?? {},
      actorUserId: r.actor_user_id,
      actorEmployeeId: r.actor_employee_id,
      changedAt: new Date(r.changed_at),
    };
  }
}
