import {
  Controller,
  Get,
  Inject,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  ENTITY_AUDIT_SERVICE,
  type IEntityAuditService,
} from '../../domain/audit/entity-audit.service';
import type {
  EntityAuditEntry,
  EntityType,
} from '../../domain/audit/entity-audit.types';

const VALID_TYPES: ReadonlySet<EntityType> = new Set([
  'shift_assignment',
  'shift_template',
  'employee',
  'company_policy',
]);

interface HistoryEntryResponse {
  id: string;
  entityType: EntityType;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  changes: Record<string, { before: unknown; after: unknown }>;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  changedAt: string;
}

const toDto = (e: EntityAuditEntry): HistoryEntryResponse => ({
  id: e.id,
  entityType: e.entityType,
  entityId: e.entityId,
  action: e.action,
  changes: e.changes,
  actorUserId: e.actorUserId,
  actorEmployeeId: e.actorEmployeeId,
  changedAt: e.changedAt.toISOString(),
});

/**
 * EntityHistoryController
 *
 * GET /entity-history/:entityType/:entityId
 *
 * Cualquier usuario autenticado puede leer el historial de una entidad
 * de su tenant (RLS lo restringe a su company_id). Sin paginación en v1
 * — el orden es desc(changed_at). Si una entidad acumula >100 entries
 * en historial, sumar limit/offset.
 */
@Controller()
export class EntityHistoryController {
  constructor(
    @Inject(ENTITY_AUDIT_SERVICE)
    private readonly audit: IEntityAuditService,
  ) {}

  @Get('entity-history/:entityType/:entityId')
  async list(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentCompany() companyId: string,
  ): Promise<HistoryEntryResponse[]> {
    if (!VALID_TYPES.has(entityType as EntityType)) {
      throw new BadRequestException(
        `entityType must be one of: ${Array.from(VALID_TYPES).join(', ')}`,
      );
    }
    const rows = await this.audit.list(
      companyId,
      entityType as EntityType,
      entityId,
    );
    return rows.map(toDto);
  }
}
