/**
 * Tipos compartidos del subsistema Entity Audit Log.
 *
 * `EntityType` debe estar sincronizado con el CHECK constraint de la
 * migration `entity_audit_log` — añadir tipos requiere también una
 * migration de ALTER TABLE.
 */
export type EntityType =
  | 'shift_assignment'
  | 'shift_template'
  | 'employee'
  | 'company_policy'
  | 'rule';

export type AuditAction = 'create' | 'update' | 'delete';

/**
 * Diff por campo. `before` y `after` son los valores serializables
 * (string | number | boolean | null | array | object). Solo se logean
 * campos cuyo valor cambió.
 */
export type ChangeSet = Record<string, { before: unknown; after: unknown }>;

export interface EntityAuditEntry {
  id: string;
  companyId: string;
  entityType: EntityType;
  entityId: string;
  action: AuditAction;
  changes: ChangeSet;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  changedAt: Date;
}
